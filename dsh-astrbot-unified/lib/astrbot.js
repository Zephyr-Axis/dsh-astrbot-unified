// 反向调用 AstrBot，并管住它那边留下的会话。
//
// 为什么要管：DSH 的 agent 每次问 AstrBot 的 LLM 都会在 AstrBot 里建一个
// conversation（webchat 平台）。问完就没用了，但会一直堆在 AstrBot 的
// 对话列表里。这里的做法是：
//   1. 每次调用用一个带前缀的临时 session_id（默认 dsh-tmp-<uuid>）
//   2. 拿到答案后立刻把这条 conversation 从 AstrBot 删掉
//   3. 万一进程挂了没删成，后台按 TTL 定期扫一遍兜底
// 想保留上下文的调用方自己传 sessionId + keep。

import { readFile, writeFile, rename } from 'node:fs/promises'

const WEBCHAT = 'webchat'
const DEFAULT_URL = 'http://127.0.0.1:6185'

/** 从 AstrBot 的 user_id 里取出 session 段。
 *  webchat:FriendMessage:webchat!<username>!<session_id> → <session_id>
 */
export function sessionOfUserId(userId) {
  const s = String(userId || '')
  if (!s.startsWith(`${WEBCHAT}:`)) return ''
  const i = s.lastIndexOf('!')
  return i >= 0 ? s.slice(i + 1) : ''
}

/** 由 username + session_id 还原出 AstrBot 侧的 user_id（webchat 的命名规则）。 */
export function userIdOf(username, sessionId) {
  return `${WEBCHAT}:FriendMessage:${WEBCHAT}!${username}!${sessionId}`
}

export function createAstrBotOps({ configPath, bindsPath, logger }) {
  // ---------- 长期会话的绑定表 ----------
  //
  // 「保留连续会话」的语义是：这条 AstrBot conversation 跟着某条 DSH 会话走，
  // DSH 那边删了才删。所以要把两者的 id 记下来。
  //   { "session-xxx": [{"sessionId":"dsh-keep-...","username":"dsh-bridge","cid":"..."}] }

  let binds = null

  async function loadBinds() {
    if (binds) return binds
    try {
      binds = JSON.parse(await readFile(bindsPath, 'utf8'))
      if (!binds || typeof binds !== 'object' || Array.isArray(binds)) binds = {}
    } catch {
      binds = {}
    }
    return binds
  }

  async function saveBinds() {
    const data = JSON.stringify(binds ?? {}, null, 2)
    const tmp = `${bindsPath}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, bindsPath)
  }

  /** 记住「这条 DSH 会话用了这条 AstrBot 会话」。 */
  async function bind({ dshSessionId, sessionId, username }) {
    if (!dshSessionId) return false
    const b = await loadBinds()
    const list = Array.isArray(b[dshSessionId]) ? b[dshSessionId] : []
    if (!list.some((x) => x.sessionId === sessionId)) {
      list.push({ sessionId, username, createdAt: Date.now() })
      b[dshSessionId] = list
      await saveBinds()
    }
    return true
  }

  /** 解绑（删掉记录，不删 AstrBot 侧）。 */
  async function unbind({ dshSessionId, sessionId }) {
    const b = await loadBinds()
    const list = Array.isArray(b[dshSessionId]) ? b[dshSessionId] : []
    const left = list.filter((x) => x.sessionId !== sessionId)
    if (left.length) b[dshSessionId] = left
    else delete b[dshSessionId]
    await saveBinds()
    return left.length !== list.length
  }

  /**
   * DSH 会话被删了 → 把它名下所有 AstrBot conversation 一起删掉。
   * 这就是「确定会话没用了才删」的落点：DSH 那边归档/删除是唯一判据。
   */
  async function dropBound(dshSessionId) {
    const b = await loadBinds()
    const list = Array.isArray(b[dshSessionId]) ? [...b[dshSessionId]] : []
    if (!list.length) return { deleted: [], kept: 0 }
    const deleted = []
    const failed = []
    for (const item of list) {
      try {
        const r = await dropSession({ sessionId: item.sessionId, username: item.username })
        if (r.deleted) deleted.push(item.sessionId)
      } catch (err) {
        failed.push({ sessionId: item.sessionId, error: String(err?.message ?? err) })
      }
    }
    // 删成功的解绑；删失败的留着，下一轮再试
    b[dshSessionId] = list.filter((x) => failed.some((f) => f.sessionId === x.sessionId))
    if (!b[dshSessionId].length) delete b[dshSessionId]
    await saveBinds()
    return { deleted, failed }
  }

  /** 列出绑定（排查用）。 */
  async function listBinds() {
    const b = await loadBinds()
    return Object.entries(b).map(([dshSessionId, items]) => ({ dshSessionId, items }))
  }

  /** 每次都重读 config.json：换 key 不用重启。 */
  async function creds() {
    try {
      const j = JSON.parse(await readFile(configPath, 'utf8'))
      return {
        url: String(j.astrbot_url || DEFAULT_URL).replace(/\/+$/, ''),
        key: String(j.astrbot_key || ''),
      }
    } catch {
      return { url: DEFAULT_URL, key: '' }
    }
  }

  async function call(path, { method = 'GET', body, query, timeoutMs = 60000 } = {}) {
    const { url, key } = await creds()
    if (!key) throw new Error('config.json 里没有 astrbot_key（AstrBot WebUI → 设置 → API Key）')
    const u = new URL(url + path)
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    }
    const res = await fetch(u, {
      method,
      headers: {
        'X-API-Key': key,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 不是 JSON 就留原文 */ }
    return { status: res.status, text, json }
  }

  /**
   * 让 AstrBot 的 LLM 回答一句话。
   * 返回 { text, username }——username 是**实际生效**的那个：
   * 撞上管理员号时会自动换名重试，调用方要用它去删会话，否则删不到。
   */
  async function chat({ text, sessionId, username, timeoutMs = 300000 }) {
    const { url, key } = await creds()
    if (!key) throw new Error('config.json 里没有 astrbot_key')
    const res = await fetch(`${url}/api/v1/chat`, {
      method: 'POST',
      headers: {
        'X-API-Key': key,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        message: [{ type: 'plain', text }],
        session_id: sessionId,
        username,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      // key 没有 chat:admin 时，username 撞上管理员号会被拒。
      // 这不是权限问题而是防冒充，换个名字重试一次就好。
      if (t.includes('reserved for an AstrBot administrator')) {
        const alt = username === 'dsh-bridge' ? 'dsh-bridge-2' : 'dsh-bridge'
        logger?.warn?.('[astrbot] username「%s」是管理员号，改用「%s」重试', username, alt)
        return chat({ text, sessionId, username: alt, timeoutMs })
      }
      throw new Error(`AstrBot /api/v1/chat → HTTP ${res.status}：${t.slice(0, 300)}`)
    }
    // SSE：只收正文，丢掉 chain_type=reasoning 的思维链
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let streamed = ''
    let complete = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        let ev
        try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
        if (ev?.type === 'plain' && ev.chain_type !== 'reasoning' && typeof ev.data === 'string') {
          streamed += ev.data
        } else if (ev?.type === 'complete' && typeof ev.data === 'string') {
          complete = ev.data
        }
      }
    }
    return { text: (complete || streamed).trim(), username }
  }

  /** 列出 AstrBot 的 conversation。给了 umo 就只查那一条会话组。 */
  async function listConversations({ umo, pageSize = 100, maxPages = 5 } = {}) {
    const out = []
    for (let page = 1; page <= maxPages; page += 1) {
      const r = await call('/api/v1/conversations', {
        query: { page, page_size: pageSize, include_history: false, ...(umo ? { umo } : {}) },
      })
      if (r.status >= 400) throw new Error(`列会话失败 HTTP ${r.status}：${r.text.slice(0, 200)}`)
      const batch = r.json?.data?.conversations ?? []
      out.push(...batch)
      if (batch.length < pageSize) break
    }
    return out
  }

  /** 找到某个 session_id 对应的 conversation（找不到返回 null）。 */
  async function findConversation({ sessionId, username }) {
    const umo = userIdOf(username, sessionId)
    let list = []
    try {
      list = await listConversations({ umo })
    } catch (err) {
      logger?.warn?.('[astrbot] 按 umo 查会话失败：%s', err?.message ?? err)
    }
    if (!list.length) {
      // umo 过滤没命中（AstrBot 版本差异）就退化成全量匹配
      const all = await listConversations({ pageSize: 100 })
      list = all.filter((c) => c.user_id === umo)
    }
    return list[0] ?? null
  }

  /** 删掉一条 conversation。 */
  async function deleteConversation(conv) {
    const r = await call(`/api/v1/conversations/${encodeURIComponent(conv.cid)}`, {
      method: 'DELETE',
      query: { user_id: conv.user_id },
    })
    if (r.status >= 400 || (r.json && r.json.status === 'error')) {
      throw new Error(`删会话失败 HTTP ${r.status}：${String(r.text).slice(0, 200)}`)
    }
    return true
  }

  /** 删掉 session_id 对应的 conversation（不存在算成功）。 */
  async function dropSession({ sessionId, username }) {
    const conv = await findConversation({ sessionId, username })
    if (!conv) return { deleted: false, reason: 'not-found' }
    await deleteConversation(conv)
    return { deleted: true, cid: conv.cid }
  }

  /**
   * 扫掉过期的临时会话。
   *
   * 命中条件（满足一个就算）：
   *   - session_id 以 prefix 开头（默认 dsh-tmp-）
   *   - 归属 username 就是桥接专用身份（byUsername=true 时）
   * 第二个条件是给「没走 /astrbot/ask、直接 curl 了 /api/v1/chat」的情况兜底：
   * 那些会话没带前缀，但同样是 DSH 问出来的，一样该清。
   */
  async function sweepTemp({ prefix, ttlMs, username, byUsername = false, now = Date.now() }) {
    const list = await listConversations({ pageSize: 100 })
    const victims = []
    for (const c of list) {
      const sid = sessionOfUserId(c.user_id)
      const mine = (sid && sid.startsWith(prefix)) ||
        (byUsername && username && String(c.user_id || '').includes(`!${username}!`))
      if (!mine) continue
      const at = Number(c.updated_at || c.created_at || 0) * 1000
      if (at && now - at < ttlMs) continue      // 还在 TTL 里，可能正被用
      victims.push(c)
    }
    const deleted = []
    for (const c of victims) {
      try {
        await deleteConversation(c)
        deleted.push({ cid: c.cid, user_id: c.user_id })
      } catch (err) {
        logger?.warn?.('[astrbot] 清理 %s 失败：%s', c.cid, err?.message ?? err)
      }
    }
    return { scanned: list.length, matched: victims.length, deleted }
  }

  return {
    creds, chat, listConversations, findConversation, deleteConversation, dropSession, sweepTemp,
    bind, unbind, dropBound, listBinds,
  }
}
