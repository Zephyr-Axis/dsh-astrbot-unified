// dsh-astrbot-unified
// AstrBot ↔ DSH 统一桥：
//   /inbound  接任务（AstrBot 的 LLM 调 dsh_ask 时走这里）
//   /append   镜像写入（AstrBot 把聊天推过来）
//   /reset    重置标记
//   /archive  归档
// 只监听 127.0.0.1。

import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Mapping } from './mapping.js'
import { TurnRegistry } from './turns.js'
import { createSessionOps } from './sessions.js'

export const name = 'dsh-astrbot-unified'
export const inject = ['sessions', 'agents', 'workspaceRegistry', 'sessionPersistence', 'agentPresets']

const DEFAULTS = { host: '127.0.0.1', port: 3188, sourceTag: 'QQ · AstrBot', asTurn: true }

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
function dataDir() { return join(dshHome(), 'dsh-astrbot-unified') }


const SKILL_NAME = 'dsh-call-astrbot'
const SKILL_PROVIDER = 'dsh-astrbot-unified'
const SKILL_RANK = 50

/**
 * DSH 对技能元数据的硬性要求（dsh-skill 的 validateCandidate / validateDefinition）。
 * 关键：DSH 只在 provider.list() 外面包了 try/catch，validateCandidate 本身没包，
 * 所以一条不合格的候选会让整轮对话直接失败。这里先在本地过一遍，坏数据不出门。
 */
function skillProblems(candidate, { needsRank = false, needsContent = false } = {}) {
  const bad = []
  if (typeof candidate.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name)) bad.push('name')
  if (typeof candidate.description !== 'string' || candidate.description.length === 0) bad.push('description')
  if (typeof candidate.source !== 'string') bad.push('source')
  if (candidate.provider !== SKILL_PROVIDER) bad.push('provider')
  // rank 只用于候选排序；加载完整定义时 DSH 不要求它
  if (needsRank && (typeof candidate.rank !== 'number' || !Number.isFinite(candidate.rank))) bad.push('rank')
  if (candidate.whenToUse !== undefined && typeof candidate.whenToUse !== 'string') bad.push('whenToUse')
  const invocation = candidate.invocation
  if (
    invocation === null || typeof invocation !== 'object' ||
    typeof invocation.modelInvocable !== 'boolean' ||
    typeof invocation.userInvocable !== 'boolean'
  ) bad.push('invocation')
  if (needsContent && (typeof candidate.content !== 'string' || candidate.content.length === 0)) bad.push('content')
  return bad
}

/** 读 SKILL.md 并缓存成功结果；读失败不缓存，下次刷新技能时会重试。 */
function bundledCallAstrbotSkill(logger) {
  let cached = null
  const load = () => {
    if (cached !== null) return cached
    const path = resolve(dirname(fileURLToPath(import.meta.url)), `../skills/${SKILL_NAME}/SKILL.md`)
    const raw = readFileSync(path, 'utf8')
    // 解析 frontmatter
    const end = raw.indexOf('\n---\n', 4)
    const fm = end > 0 ? raw.slice(4, end) : ''
    const descMatch = fm.match(/^description:\s*"([^"]+)"/m) || fm.match(/^description:\s*(.+)$/m)
    const description = descMatch ? descMatch[1].trim() : 'Call AstrBot from DSH'
    const content = end > 0 ? raw.slice(end + 5) : raw
    return (cached = {
      meta: {
        name: SKILL_NAME,
        description,
        source: 'bundled',
        provider: SKILL_PROVIDER,
        invocation: { modelInvocable: true, userInvocable: true },
      },
      path,
      content,
    })
  }
  const warn = (what, detail) => {
    // 自己拼好字符串，不依赖各版本 logger 的 printf 支持
    const text = typeof detail === 'string' ? detail : (detail?.message ?? String(detail))
    logger?.warn?.(`[unified] 技能「${SKILL_NAME}」不可用（${what}）：${text}`)
  }

  return {
    name: SKILL_PROVIDER,
    // 任何异常都降级成「暂时没有这个技能」，绝不把问题抛给 DSH 的整轮对话
    list() {
      try {
        const { meta, path } = load()
        const candidate = { ...meta, rank: SKILL_RANK, locator: path }
        const bad = skillProblems(candidate, { needsRank: true })
        if (bad.length) {
          warn('元数据不合格', bad.join('、'))
          return []
        }
        return [candidate]
      } catch (err) {
        warn('读取失败', err)
        return []
      }
    },
    get() {
      try {
        const { meta, content } = load()
        const definition = { ...meta, content }
        const bad = skillProblems(definition, { needsContent: true })
        if (bad.length) {
          warn('定义不合格', bad.join('、'))
          return undefined
        }
        return definition
      } catch (err) {
        warn('读取失败', err)
        return undefined
      }
    },
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const logger = ctx.logger(name)
  const state = { token: '', server: null }

  // 注册「调用 AstrBot」的技能，让 agent 知道怎么反向调 AstrBot
  ctx.inject(['skills'], (skillCtx) => {
    try {
      skillCtx.skills.registerProvider(() => bundledCallAstrbotSkill(logger))
    } catch (err) {
      logger?.warn?.('[unified] 注册 skill 失败：%s', err?.message ?? err)
    }
  })

  const turns = new TurnRegistry()
  const mapping = new Mapping(join(dataDir(), 'mapping.json'))
  const ops = createSessionOps(ctx, mapping, config, logger)

  ctx.effect(() => () => { state.server?.close?.() })

  ;(async () => {
    await mapping.load()
    state.token = await loadToken()
    startServer()
    // 定期清理死回合
    setInterval(() => turns.sweep(), 5 * 60 * 1000).unref?.()
  })().catch((err) => logger.error?.('[unified] 启动失败：%s', err?.message ?? err))

  async function loadToken() {
    const p = join(dataDir(), 'config.json')
    try {
      const j = JSON.parse(await readFile(p, 'utf8'))
      if (j?.token) return j.token
    } catch { /* 不存在就建 */ }
    const token = randomBytes(24).toString('hex')
    await mkdir(dataDir(), { recursive: true })
    // 顺便生成 AstrBot 侧的占位配置，让用户知道要填什么
    await writeFile(p, JSON.stringify({
      token,
      astrbot_url: 'http://127.0.0.1:6185',
      astrbot_key: '',
      _note: 'astrbot_key 需要在 AstrBot WebUI 里创建（设置 → API Key，勾 im 和 chat）',
    }, null, 2), { mode: 0o600 })
    return token
  }

  function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  async function readBody(req, limit = 4 * 1024 * 1024) {
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > limit) throw new Error('body too large')
      chunks.push(c)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  function authed(req) {
    const h = req.headers.authorization || ''
    return h === `Bearer ${state.token}`
  }

  // ---------- session/event：把 agent 输出接到对应回合 ----------

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId) return
    const turn = turns.get(sessionId)
    if (!turn || turn.done) return

    const type = event?.type
    const data = event?.data || {}
    turn.lastEventAt = Date.now()
    if (Number.isFinite(Number(data.turn))) turn.turnNo = Number(data.turn)

    if (type === 'turn/start') {
      turn.turnNo = data.turn
      turn.write('status', { text: `第 ${data.turn} 轮开始` })
    } else if (type === 'assistant/message') {
      const msg = data.message
      const blocks = Array.isArray(msg?.content) ? msg.content : []
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) turn.pushText(b.text)
      }
    } else if (type === 'tool/call') {
      turn.pushTool(data?.name || data?.tool)
    } else if (type === 'turn/end') {
      const reason = data?.reason?.kind || 'completed'
      const errMsg = data?.reason?.error?.message
      if (reason === 'error' && errMsg) {
        // 把上游的真实原因带回去，别让 AstrBot 只看到「执行失败」
        turn.write('error', { message: String(errMsg).slice(0, 500) })
      }
      turn.finish(reason)
      turns.drop(sessionId)
    }
  })

  // ---------- HTTP ----------

  function startServer() {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      try {
        if (req.method === 'GET' && url.pathname === '/health') {
          return json(res, 200, {
            ok: true, plugin: name, host: config.host, port: config.port,
            capabilities: ['inbound-task', 'mirror-append', 'mirror-reset', 'mirror-archive', 'session-map'],
          })
        }
        if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' })

        if (req.method === 'GET' && url.pathname === '/map') {
          const umo = url.searchParams.get('umo') || ''
          return json(res, 200, { ok: true, data: umo ? { [umo]: mapping.cidsOf(umo) } : mapping.data })
        }

        // 接任务：AstrBot 的 LLM 决定要 DSH 干活时走这里
        if (req.method === 'POST' && url.pathname === '/inbound') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const umo = String(body?.umo || '').trim()
          const text = String(body?.text || '').trim()
          if (!umo) return json(res, 400, { ok: false, error: 'umo required' })
          if (!text) return json(res, 400, { ok: false, error: 'text required' })

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          res.write(': ok\n\n')

          // 复用镜像已建的会话：同一个群不另起会话，执行和记录走同一条时间线
          let sessionId = mapping.anySessionOf(umo)
          if (!sessionId) {
            // 还没有镜像过，就先建一个（cid 用固定的 exec key）
            const r = await ops.ensureSession(umo, 'exec', { cwd: body.cwd })
            sessionId = r.sessionId
          } else {
            // 确保它在内存里（重启后可能只在磁盘上）
            await ops.ensureSession(umo, mapping.firstCidOf(umo) || 'exec', { cwd: body.cwd })
          }
          const turn = turns.create({ umo, sessionId, res })
          turn.write('status', { text: '已接入 DSH' })

          const agent = ctx.agents.get?.(sessionId)
          if (!agent) {
            turn.fail(`会话 ${sessionId} 没挂载起来`)
            return
          }
          try {
            agent.followup({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'user', rpcId: randomUUID() },
            })
          } catch (err) {
            turn.fail(`投递失败：${err?.message ?? err}`)
          }
          return
        }

        // 镜像写入
        if (req.method === 'POST' && url.pathname === '/append') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const { umo, cid, role, text } = body
          if (!umo || !cid) return json(res, 400, { ok: false, error: 'umo 和 cid 必填' })
          if (!text) return json(res, 400, { ok: false, error: 'text 必填' })
          const { sessionId, created } = await ops.ensureSession(umo, cid, { cwd: body.cwd })
          if (role === 'assistant') {
            const n = (turns.get(sessionId)?.turnNo ?? 0) + 1
            await ops.appendAsTurn(sessionId, { text, turnNo: n, provider: 'astrbot', model: config.sourceTag })
          } else {
            await ops.appendUserMessage(sessionId, text)
          }
          return json(res, 200, { ok: true, sessionId, created })
        }

        if (req.method === 'POST' && url.pathname === '/reset') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const { umo, cid } = body
          if (!umo || !cid) return json(res, 400, { ok: false, error: 'umo 和 cid 必填' })
          const known = mapping.get(umo, cid)
          if (!known) return json(res, 200, { ok: true, skipped: 'no-mapping' })
          await ops.appendResetMarker(known.sessionId)
          return json(res, 200, { ok: true, sessionId: known.sessionId })
        }

        // 列出孤儿会话：磁盘上有、映射表里没有的（用于排查「删不掉」）
        if (req.method === 'GET' && url.pathname === '/orphans') {
          const snaps = await ctx.sessionPersistence?.list?.() ?? []
          const mapped = new Set()
          for (const cids of Object.values(mapping.data)) {
            for (const rec of Object.values(cids)) {
              if (rec?.sessionId) mapped.add(rec.sessionId)
            }
          }
          const orphans = (snaps || [])
            .map((x) => ({ id: x?.header?.id, cwd: x?.header?.cwd }))
            .filter((x) => x.id && !mapped.has(x.id) && String(x.cwd || '').includes('/qq/'))
          return json(res, 200, { ok: true, count: orphans.length, orphans })
        }

        // 清理所有孤儿会话（映射表里没有的 qq 会话）
        if (req.method === 'POST' && url.pathname === '/clean-orphans') {
          const snaps = await ctx.sessionPersistence?.list?.() ?? []
          const mapped = new Set()
          for (const cids of Object.values(mapping.data)) {
            for (const rec of Object.values(cids)) if (rec?.sessionId) mapped.add(rec.sessionId)
          }
          const targets = (snaps || [])
            .map((x) => ({ id: x?.header?.id, cwd: x?.header?.cwd }))
            .filter((x) => x.id && !mapped.has(x.id) && String(x.cwd || '').includes('/qq/'))
          const archived = []
          for (const t of targets) {
            if (await ops.archive(t.id)) archived.push(t.id)
          }
          logger?.info?.('[unified] 清理孤儿：%d 个', archived.length)
          return json(res, 200, { ok: true, archived, count: archived.length })
        }

        // 按 umo 清空：归档该群/私聊下的所有会话（含映射表里没有的孤儿）
        if (req.method === 'POST' && url.pathname === '/archive-umo') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const { umo } = body
          if (!umo) return json(res, 400, { ok: false, error: 'umo 必填' })

          // 1) 映射表里记着的
          const known = mapping.cidsOf(umo).map((cid) => mapping.get(umo, cid)?.sessionId).filter(Boolean)
          // 2) 磁盘上属于该 umo 目录的所有会话（含孤儿）
          const cwd = ops.cwdFor(umo)
          let onDisk = []
          try {
            const snaps = await ctx.sessionPersistence?.list?.()
            onDisk = (snaps || [])
              .filter((x) => {
                const c = x?.header?.cwd
                return typeof c === 'string' && c.toLowerCase() === String(cwd).toLowerCase()
              })
              .map((x) => x?.header?.id ?? x?.id)
              .filter(Boolean)
          } catch (err) {
            logger?.warn?.('[unified] 列磁盘会话失败：%s', err?.message ?? err)
          }

          const all = [...new Set([...known, ...onDisk])]
          const archived = []
          for (const sid of all) {
            if (await ops.archive(sid)) archived.push(sid)
          }
          // 清掉映射
          for (const cid of mapping.cidsOf(umo)) mapping.drop(umo, cid)
          await mapping.save()

          // 工作区空了就删掉实体，否则界面上还留一个空分组
          let removedWorkspace = null
          try {
            const norm = String(cwd).toLowerCase()
            for (const ws of await (ctx.workspaceRegistry?.list?.() ?? [])) {
              if (String(ws?.path || '').toLowerCase() !== norm) continue
              if ((ws.sessionIds?.length ?? 0) > 0) continue     // 还有别的会话，留着
              if (typeof ctx.workspaceRegistry.delete === 'function') {
                await ctx.workspaceRegistry.delete(ws.id)
                removedWorkspace = ws.path
                logger?.info?.('[unified] 删除空工作区 %s', ws.path)
              }
            }
          } catch (err) {
            logger?.warn?.('[unified] 删除空工作区失败：%s', err?.message ?? err)
          }

          logger?.info?.('[unified] 按 umo 清空 %s：归档 %d 个', umo, archived.length)
          return json(res, 200, {
            ok: true, umo, archived, count: archived.length,
            removedWorkspace,
          })
        }

        if (req.method === 'POST' && url.pathname === '/archive') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const { umo, cid, sessionId } = body
          let target = sessionId
          if (!target) {
            if (!umo || !cid) return json(res, 400, { ok: false, error: 'umo+cid 或 sessionId 必填' })
            target = mapping.get(umo, cid)?.sessionId
          }
          if (!target) return json(res, 200, { ok: true, skipped: 'no-mapping' })
          const ok = await ops.archive(target)
          if (umo && cid) { mapping.drop(umo, cid); await mapping.save() }
          return json(res, 200, { ok, sessionId: target })
        }

        return json(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        logger.warn?.('[unified] 请求失败：%s', err?.message ?? err)
        if (!res.headersSent) json(res, 500, { ok: false, error: String(err?.message ?? err) })
      }
    })
    server.listen(config.port, config.host, () => {
      logger.info?.('[unified] listening on http://%s:%s', config.host, config.port)
    })
    state.server = server
  }
}

export default { name, inject, apply }
