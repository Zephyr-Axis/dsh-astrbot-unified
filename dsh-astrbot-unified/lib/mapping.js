// umo → cid → sessionId 的映射表，落盘成 JSON。
import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'

export class Mapping {
  constructor(path) {
    this.path = path
    this.data = {}   // { umo: { cid: { sessionId, createdAt } } }
    this.dirty = false
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') this.data = parsed
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      this.data = {}
    }
    return this
  }

  get(umo, cid) {
    return this.data[umo]?.[cid] ?? null
  }

  set(umo, cid, sessionId) {
    if (!this.data[umo]) this.data[umo] = {}
    this.data[umo][cid] = { sessionId, createdAt: Date.now() }
    this.dirty = true
  }


  /** 该 umo 下第一个 cid（用于把已存在的会话 resume 起来）。 */
  firstCidOf(umo) {
    const cids = this.data[umo]
    if (!cids) return null
    return Object.keys(cids)[0] ?? null
  }

  /**
   * 该 umo 下任意一个已绑定的 sessionId（执行任务时复用它，避免另起会话）。
   * 优先返回最近创建的那个。
   */
  anySessionOf(umo) {
    const cids = this.data[umo]
    if (!cids) return null
    let best = null
    for (const rec of Object.values(cids)) {
      if (!rec?.sessionId) continue
      if (!best || (rec.createdAt ?? 0) > (best.createdAt ?? 0)) best = rec
    }
    return best?.sessionId ?? null
  }

  /** 删掉某条 cid 的映射（对应 AstrBot 删除会话） */
  drop(umo, cid) {
    if (this.data[umo]?.[cid]) {
      delete this.data[umo][cid]
      if (Object.keys(this.data[umo]).length === 0) delete this.data[umo]
      this.dirty = true
      return true
    }
    return false
  }

  /** 该 umo 下所有 cid */
  cidsOf(umo) {
    return Object.keys(this.data[umo] ?? {})
  }

  /** 反查：sessionId → { umo, cid } */
  findBySession(sessionId) {
    for (const [umo, cids] of Object.entries(this.data)) {
      for (const [cid, rec] of Object.entries(cids)) {
        if (rec?.sessionId === sessionId) return { umo, cid }
      }
    }
    return null
  }

  async save() {
    if (!this.dirty) return
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    await rename(tmp, this.path)   // 原子替换，避免写一半损坏
    this.dirty = false
  }
}
