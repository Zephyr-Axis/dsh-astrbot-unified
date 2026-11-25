// 回合管理：把 agent 的流式输出收集起来，供 /inbound 的 SSE 回传。
import { randomUUID } from 'node:crypto'

/** 一个回合的输出收集器。 */
export class Turn {
  constructor({ umo, sessionId, res }) {
    this.umo = umo
    this.sessionId = sessionId
    this.res = res
    this.turnNo = null
    this.chunks = []
    this.toolCount = 0
    this.lastTool = null
    this.createdAt = Date.now()
    this.lastEventAt = Date.now()
    this.done = false
  }

  write(event, data) {
    if (this.res && !this.res.writableEnded) {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
  }

  /** 正文：先压着，等 turn/end 再一起发，避免被切碎。 */
  pushText(text) {
    if (!text) return
    this.chunks.push(text)
    this.lastEventAt = Date.now()
  }

  pushTool(name) {
    if (!name) return
    this.toolCount += 1
    this.lastTool = name
    this.lastEventAt = Date.now()
  }

  get text() {
    return this.chunks.join('')
  }

  finish(reason = 'completed') {
    if (this.done) return
    this.done = true
    const body = this.text.trim()
    if (body) this.write('text', { text: body })
    this.write('done', { sessionId: this.sessionId, reason })
    try { this.res?.end() } catch { /* ignore */ }
  }

  fail(message) {
    if (this.done) return
    this.done = true
    this.write('error', { message })
    this.write('done', { sessionId: this.sessionId })
    try { this.res?.end() } catch { /* ignore */ }
  }
}

/** sessionId -> Turn，供 session/event 分发。 */
export class TurnRegistry {
  constructor() { this.map = new Map() }

  create(opts) {
    const t = new Turn(opts)
    this.map.set(opts.sessionId, t)
    return t
  }

  get(sessionId) { return this.map.get(sessionId) }

  drop(sessionId) { this.map.delete(sessionId) }

  /** 只保留还活着的回合，防止内存泄漏。 */
  sweep(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now()
    for (const [id, t] of this.map) {
      if (t.done || now - t.lastEventAt > maxAgeMs) this.map.delete(id)
    }
  }
}
