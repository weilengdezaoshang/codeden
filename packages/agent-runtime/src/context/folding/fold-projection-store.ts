import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CorruptedFoldProjectionError,
  FoldProjectionSchema,
  type FoldProjection,
} from './folded-memory.js'

const PROJECTION_FILE = 'fold-projection.json'

/**
 * FoldProjectionStore —— 主计划 9.20 第六步：折叠投影原子落盘。
 * 投影是 Session 目录内的派生文件（fold-projection.json）；原始事件（updates.jsonl /
 * chat_history.jsonl）不删除、不改写。
 */
export class FoldProjectionStore {
  private readonly sessionsRoot: string

  constructor(projectRoot: string) {
    this.sessionsRoot = path.join(projectRoot, '.codeden', 'sessions')
  }

  async save(sessionId: string, projection: FoldProjection): Promise<void> {
    const directory = this.sessionDirectory(sessionId)
    await mkdir(directory, { recursive: true })
    const payload = FoldProjectionSchema.parse(projection)
    const target = path.join(directory, PROJECTION_FILE)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  }

  /**
   * 读取折叠投影。文件不存在返回 undefined；存在但损坏/校验失败抛出
   * CorruptedFoldProjectionError，由调用方按主计划 9.20 回退旧历史。
   */
  async load(sessionId: string): Promise<FoldProjection | undefined> {
    let raw: string
    try {
      raw = await readFile(path.join(this.sessionDirectory(sessionId), PROJECTION_FILE), 'utf8')
    } catch (error) {
      if (isMissing(error)) {
        return undefined
      }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new CorruptedFoldProjectionError(`折叠投影不是合法 JSON：${sessionId}`)
    }
    const parsed = FoldProjectionSchema.safeParse(value)
    if (!parsed.success) {
      throw new CorruptedFoldProjectionError(`折叠投影校验失败：${sessionId}`)
    }
    return parsed.data
  }

  /** 删除会话时同步清理投影；投影文件本就随会话目录存在。 */
  async clear(sessionId: string): Promise<void> {
    await rm(path.join(this.sessionDirectory(sessionId), PROJECTION_FILE), { force: true })
  }

  private sessionDirectory(sessionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(sessionId)) {
      throw new Error('Session id must contain only letters, numbers, dot, underscore, or dash')
    }
    return path.join(this.sessionsRoot, sessionId)
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
