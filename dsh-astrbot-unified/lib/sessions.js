// 会话操作：按 cid 找/建 DSH 会话、归档、注入消息。
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'

const SOURCE_KIND = 'astrbot-mirror'

/**
 * 从 umo 推导出工作目录。
 *   pre-config:GroupMessage:751469861        → <base>/qq/groups/751469861
 *   pre-config:FriendMessage:2242272951      → <base>/qq/private/2242272951
 * 同一个群的不同 conversation 共用一个目录：agent 该看到同一批文件。
 */
export function cwdForUmo(umo, base) {
  const parts = String(umo || '').split(':')
  const kind = parts[1] || ''
  const id = (parts[2] || 'unknown').replace(/[^\w.-]/g, '_')
  const sub = kind === 'GroupMessage' ? join('groups', id)
    : kind === 'FriendMessage' ? join('private', id)
    : join('other', id)
  return join(base, 'qq', sub)
}

export function createSessionOps(ctx, mapping, config, logger) {
  const tag = config.sourceTag ?? 'QQ · AstrBot'

  /** 找一个已存在的活会话 */





  /** 恢复/创建会话时的默认模型选项（照官方 getOrCreateAgent 的做法）。 */
  function defaultAgentOptions() {
    const opts = {}
    try {
      const def = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (def?.provider) opts.provider = def.provider
      if (def?.model) opts.model = def.model
    } catch { /* ignore */ }
    return opts
  }

  /** 磁盘上是否存在这个会话（避免把「没在内存」误判为「不存在」）。 */
  async function existsOnDisk(sessionId) {
    try {
      const snaps = await ctx.sessionPersistence?.list?.()
      return Array.isArray(snaps) && snaps.some((x) => (x?.header?.id ?? x?.id) === sessionId)
    } catch {
      return false
    }
  }

  /**
   * 强制把会话缓冲区落到磁盘。
   *
   * 为什么必须调：session.append() 只进内存缓冲，磁盘上的 jsonl 要等 flush 才出现。
   * 不 flush 的话界面上「只有目录没有数据」（实测踩到）。
   */
  async function flushSession(sessionId) {
    const s = live(sessionId)
    if (!s) return false
    try {
      await ctx.sessions?.flush?.(s)
      return true
    } catch (err) {
      logger?.warn?.('[mirror] flush %s 失败：%s', sessionId, err?.message ?? err)
      return false
    }
  }

  /** 给会话设个标题，省得界面显示「新对话」。失败不影响主流程。 */
  async function setTitle(sessionId, title) {
    try {
      const titles = ctx.get?.('sessionTitle') ?? ctx.sessionTitle
      if (!titles || typeof titles.rename !== 'function') return false
      const s = live(sessionId)
      if (!s) return false
      titles.rename(s, title)
      return true
    } catch (err) {
      logger?.debug?.('[mirror] 设置标题失败：%s', err?.message ?? err)
      return false
    }
  }

  /** 拿 agentPresets 服务（不同版本可能挂在 ctx 或 ctx.get） */
  function agentPresetsService() {
    try {
      return ctx.get?.('agentPresets') ?? ctx.agentPresets ?? null
    } catch { return null }
  }

  /**
   * 解析一个当前真实存在的 preset id。
   * 不能写死名字：写死一个已不存在的 preset 会让会话头记上无效值，
   * 之后任何 resume（含界面打开）都会失败。
   */
  async function resolveAgentPreset() {
    const presets = agentPresetsService()
    if (!presets) return undefined
    const wanted = typeof presets.defaultId === 'string' && presets.defaultId.trim()
      ? presets.defaultId.trim()
      : 'standard'
    try {
      if (typeof presets.resolve === 'function') {
        const resolved = await presets.resolve(wanted)
        if (resolved?.id) return resolved.id
      }
      return wanted
    } catch (err) {
      logger?.warn?.('[mirror] agent preset "%s" 不可用：%s', wanted, err?.message ?? err)
      return undefined
    }
  }

  /** preset 需要显式 mount 到 agent 的 ctx 上，不然会话缺上下文 */
  function presetSetup(presetId) {
    if (!presetId) return undefined
    return async (agentCtx) => {
      const presets = agentPresetsService()
      if (!presets?.mount) return
      try {
        await presets.mount(agentCtx, presetId)
      } catch (err) {
        logger?.warn?.('[mirror] mount preset "%s" 失败：%s', presetId, err?.message ?? err)
      }
    }
  }

  /** 已存在会话推回 job 时用的 cwd：按 umo 推导，跟新建时同一套规则。 */
  function knownCwd(umo) {
    const base = config.baseCwd || config.cwd || process.cwd()
    return cwdForUmo(umo, base)
  }

  function live(sessionId) {
    try { return ctx.sessions?.get?.(sessionId) ?? null } catch { return null }
  }


  /** 把会话挂到 cwd 对应的工作区；没有就建一个，省得它在 DSH 里待在「未分组」。 */
  async function attachWorkspace(sessionId, cwd) {
    try {
      const reg = ctx.workspaceRegistry
      if (!reg?.list) return
      const entities = await reg.list()
      const norm = String(cwd).toLowerCase()
      const match = (entities || []).find((ws) => ws?.path && String(ws.path).toLowerCase() === norm)
      if (match?.attachSession) {
        await match.attachSession(sessionId)
        return
      }
      if (typeof reg.create === 'function') {
        const created = await reg.create(cwd, basename(cwd) || cwd)
        if (created?.attachSession) await created.attachSession(sessionId)
        logger?.info?.('[mirror] 新建工作区 %s', cwd)
      }
    } catch (err) {
      logger?.warn?.('[mirror] 挂工作区失败（%s）：%s', cwd, err?.message ?? err)
    }
  }

  /**
   * 拿到 cid 对应的 DSH 会话；没有就新建一个。
   * @returns {{sessionId:string, created:boolean}}
   */
  async function ensureSession(umo, cid, opts = {}) {
    const known = mapping.get(umo, cid)
    if (known?.sessionId) {
      const s = live(known.sessionId)
      const archived = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
      // 归档了就取消归档
      if (archived.has(known.sessionId)) {
        try {
          await ctx.workspaceRegistry.unarchiveSession(known.sessionId)
          logger?.info?.('[mirror] 取消归档 %s', known.sessionId)
        } catch (err) {
          logger?.warn?.('[mirror] 取消归档失败：%s', err?.message ?? err)
        }
      }
      if (s) {
        await attachWorkspace(known.sessionId, knownCwd(umo))
        return { sessionId: known.sessionId, created: false }
      }
      // 不在内存里但磁盘上存在 → 必须 resume，不能重建（重建会撞 "already exists"）
      const onDisk = await existsOnDisk(known.sessionId)
      if (onDisk) {
        try {
          const presetId = await resolveAgentPreset()
          await ctx.agents.resume({
            resumeSessionId: known.sessionId,
            agentOptions: defaultAgentOptions(),
            setup: presetSetup(presetId),
          })
          await attachWorkspace(known.sessionId, knownCwd(umo))
          logger?.info?.('[mirror] 恢复会话 %s', known.sessionId)
          return { sessionId: known.sessionId, created: false }
        } catch (err) {
          logger?.warn?.('[mirror] resume %s 失败：%s，将重建', known.sessionId, err?.message ?? err)
        }
      }
      logger?.warn?.('[mirror] 会话 %s 不存在，为 cid %s 重建', known.sessionId, cid.slice(0, 8))
    }

    // 目录：显式 cwd > 按 umo 推导 > 配置里的 baseCwd
    const base = config.baseCwd || config.cwd || process.cwd()
    const cwd = opts.cwd || cwdForUmo(umo, base)
    try {
      await mkdir(cwd, { recursive: true })   // agents.create 要求目录已存在
    } catch (err) {
      logger?.warn?.('[mirror] 建目录 %s 失败：%s', cwd, err?.message ?? err)
    }
    // 官方写法：cwd 放在 meta 里 + 带上 agentPreset（缺了它界面打不开会话）+ setup 里 mount
    //
    // 关键：sessionId 必须自己生成 UUID，不能让 DSH 用内建的 `session-${counter}`。
    // counter 是进程内的，重启后归零，会跟磁盘上已有的 session-1/session-2 撞车
    // （报 "session session-1 already exists"）。官方插件也是 `session-${randomUUID()}`。
    const presetId = await resolveAgentPreset()
    const created = await ctx.agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      agentOptions: defaultAgentOptions(),
      setup: presetSetup(presetId),
    })
    const agent = created?.agent ?? created
    const sessionId = agent?.session?.id ?? created?.sessionId ?? created?.id
    if (!sessionId) throw new Error('agents.create 没有返回 sessionId')
    mapping.set(umo, cid, sessionId)
    await mapping.save()
    await attachWorkspace(sessionId, cwd)
    // 标题用 umo 的可读形式，例：QQ · 群 303582303
    const parts = String(umo).split(':')
    const kindLabel = parts[1] === 'GroupMessage' ? '群' : parts[1] === 'FriendMessage' ? '私聊' : '会话'
    await setTitle(sessionId, `${config.sourceTag ?? 'QQ'} · ${kindLabel} ${(parts[2] || '').slice(0, 12)}`)
    logger?.info?.('[mirror] 为 cid %s 新建会话 %s（%s）', cid.slice(0, 8), sessionId, cwd)
    return { sessionId, created: true }
  }


  /**
   * 伪造一个完整回合并写入助手消息。
   *
   * 为什么需要：界面按「回合」分组显示会话，只有 user/message 的会话没有回合，
   * 界面上不显示。这里补上 turn/start → step/start → assistant/message → step/end → turn/end。
   *
   * 风险：assistant/message 需要 turn/step/stream 三个字段，编错会让会话校验失败。
   * 所以调用方必须先备份会话文件。
   */

  /**
   * 找当前「开着」的回合：最后一条 turn/start 后面没有 turn/end。
   *
   * 为什么需要：真实 DSH 会话的顺序是
   *   turn/start → step/start → user/message → assistant/message → step/end → turn/end
   * 用户消息在回合**里面**。镜像以前是「user/message 单独写、助手回复另起一个回合」，
   * 结果 turnOutline 把 prompt 算错、界面上的用户气泡丢了一半（实测）。
   * 所以现在：用户消息开一个回合但先不收尾，助手回复来的时候再补完。
   */
  function openTurn(sessionId) {
    const s = live(sessionId)
    const log = s?.log
    if (!Array.isArray(log)) return null
    let open = null
    for (const e of log) {
      if (e?.type === 'turn/start') {
        const n = Number(e?.data?.turn)
        open = Number.isSafeInteger(n) ? { turn: n, step: 0 } : null
      } else if (e?.type === 'step/start' && open) {
        const st = Number(e?.data?.step)
        if (Number.isSafeInteger(st)) open.step = st
      } else if (e?.type === 'turn/end') {
        open = null
      }
    }
    return open
  }

  /** 把开着的回合收尾（上一轮没等到助手回复，或者来了新的用户消息）。 */
  function closeTurn(s, open) {
    if (!open) return
    const step = open.step || 1
    s.append('step/end', { turn: open.turn, step })
    s.append('turn/end', { turn: open.turn, reason: { kind: 'completed' } })
  }

  /**
   * 写一条用户消息。
   *
   * 按真实 DSH 的顺序：回合先开，用户消息在回合里面。
   * 这样 turnOutline 的 prompt 才会是这条用户消息，界面也才会渲染成用户气泡。
   */
  async function appendUserMessage(sessionId, text) {
    const s = live(sessionId)
    if (!s || typeof s.append !== 'function') throw new Error('会话不可写')
    const open = openTurn(sessionId)
    if (open) closeTurn(s, open)          // 上一轮没等到回复，先收尾
    const turn = lastTurnNo(sessionId) + 1
    const step = 1
    s.append('turn/start', { turn })
    s.append('step/start', { turn, step })
    // 带 rpcId：客户端靠它把消息认成「用户提交的」，没有就不渲染成用户气泡
    s.append('user/message', {
      id: randomUUID(),
      role: 'user',
      source: { kind: 'user', rpcId: randomUUID() },
      content: [{ type: 'text', text }],
    }, { surfaceOp: 'append' })
    await flushSession(sessionId)
    return true
  }

  /**
   * 会话里已经用到第几轮了。
   *
   * 为什么不能靠内存里的回合表：镜像写入是「用户说一句 → 助手回一句」两次独立请求，
   * 中间没有活着的回合对象，`turns.get()` 永远是空的，于是每次都写 turn: 1。
   * 结果 DSH 的 turnOutline 只认最后一轮，界面上前面的轮次被吞掉（实测）。
   * 所以直接翻会话日志找最大的 turn/start。
   */
  function lastTurnNo(sessionId) {
    const s = live(sessionId)
    const log = s?.log
    if (!Array.isArray(log)) return 0
    let max = 0
    for (const e of log) {
      if (e?.type !== 'turn/start') continue
      const n = Number(e?.data?.turn)
      if (Number.isSafeInteger(n) && n > max) max = n
    }
    return max
  }

  async function appendAsTurn(sessionId, { text, turnNo, provider, model }) {
    const s = live(sessionId)
    if (!s || typeof s.append !== 'function') throw new Error('会话不可写')

    // 用户消息开了回合就接在它里面（prompt 和回复才会归到同一轮）；
    // 没有开着的回合（比如重启后先收到助手回复）就自己起一个。
    const open = openTurn(sessionId)
    const turn = open?.turn ?? (Number.isSafeInteger(turnNo) && turnNo > 0 ? turnNo : lastTurnNo(sessionId) + 1)
    const step = open?.step || 1
    if (!open) {
      s.append('turn/start', { turn })
      s.append('step/start', { turn, step })
    }
    // 关键：assistant/message 的校验强制要求 source.kind === 'model' + provider/model。
    // 标成外部来源会被拒（实测），所以这里如实记成「AstrBot 那边的模型产出的」。
    const src = { kind: 'model', provider: provider || 'astrbot', model: model || 'mirror' }

    s.append('assistant/message', {
      turn,
      step,
      message: {
        id: randomUUID(),
        role: 'assistant',
        source: src,
        content: [{ type: 'text', text }],
      },
      stream: [],
    }, { surfaceOp: 'append' })
    s.append('step/end', { turn, step })
    s.append('turn/end', { turn, reason: { kind: 'completed' } })
    await flushSession(sessionId)
    return true
  }

  /**
   * 往会话里写一条「外部来源」的消息。
   * 用 user/message + 来源提示词：模型看得到，也知道不是自己说的。
   */
  async function appendExternal(sessionId, { role, text, at, meta }) {
    const s = live(sessionId)
    if (!s) throw new Error(`会话 ${sessionId} 不在内存里`)
    if (typeof s.append !== 'function') throw new Error('会话不支持 append')

    const header = `[外部来源：${tag}${meta?.umo ? ` · ${meta.umo}` : ''}` +
      `${meta?.cid ? ` · 会话 ${String(meta.cid).slice(0, 8)}` : ''}` +
      `${at ? ` · ${new Date(at).toISOString()}` : ''}]`
    const body = `${header}\n${role === 'assistant' ? '对方助手' : '对方用户'}：${text}`

    // user/message 的校验比 assistant 宽松得多：
    // 只需 {id, role:'user', source:{kind}, content:[]}
    s.append('user/message', {
      id: randomUUID(),
      role: 'user',
      source: { kind: SOURCE_KIND },
      content: [{ type: 'text', text: body }],
    }, { surfaceOp: 'append' })
    await flushSession(sessionId)
    return true
  }

  /** 标记「此前的上下文作废」（对应 AstrBot 的 /reset） */
  async function appendResetMarker(sessionId) {
    const s = live(sessionId)
    if (!s) return false
    // 必须带 rpcId：否则界面不渲染成用户气泡，看起来像「没反应」（实测）
    s.append('user/message', {
      id: randomUUID(),
      role: 'user',
      source: { kind: 'user', rpcId: randomUUID() },
      content: [{ type: 'text', text: `[${tag}] —— 对方已重置对话，此前上下文作废 ——` }],
    }, { surfaceOp: 'append' })
    return true
  }

  /**
   * 归档会话（AstrBot 删了对应 conversation）。
   *
   * 注意：DSH 的 archiveSession 只往 archivedSessionIds 加标记，
   * **不会从 workspace.sessionIds 里摘掉**（注释里明说「归档的会话仍占着槽位」）。
   * 而界面列表读的是 sessionIds，所以必须自己补这一步，否则「归档了但还显示」。
   */
  async function archive(sessionId) {
    try {
      await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    } catch (err) {
      logger?.warn?.('[unified] 归档 %s 失败：%s', sessionId, err?.message ?? err)
      return false
    }
    // 从所有工作区的 sessionIds 里摘掉
    try {
      const reg = ctx.workspaceRegistry
      for (const ws of await (reg?.list?.() ?? [])) {
        if (!ws?.sessionIds?.includes?.(sessionId)) continue
        if (typeof ws.detachSession === 'function') {
          await ws.detachSession(sessionId)
          logger?.info?.('[unified] 已从工作区 %s 摘除 %s', ws.path, sessionId)
        }
      }
    } catch (err) {
      logger?.warn?.('[unified] 摘除 %s 时出错：%s', sessionId, err?.message ?? err)
    }
    return true
  }

  return {
    ensureSession, appendExternal, appendResetMarker, appendAsTurn,
    appendUserMessage, archive, setTitle, flushSession,
    // 已绑定 base 的版本，调用方不用自己算
    cwdFor: (umo) => cwdForUmo(umo, config.baseCwd || config.cwd || process.cwd()),
  }
}
