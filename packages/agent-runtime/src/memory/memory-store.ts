import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export type MemoryScope = 'project' | 'user'
export type MemoryKind = 'preference' | 'fact' | 'decision'

export interface MemoryEntry {
  readonly id: string
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly content: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface MemoryStoreOptions {
  projectRoot: string
  userHome?: string
  maxEntries?: number
  maxContentChars?: number
}

const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_CONTENT_CHARS = 2_000
const SECRET_PATTERN = /(sk-[A-Za-z0-9]|xai-[A-Za-z0-9]|bearer\s+[A-Za-z0-9._-]+)/iu

/** 轻量、可审计的文件记忆存储；记忆仅作为不可信上下文注入模型。 */
export class MemoryStore {
  private readonly projectPath: string
  private readonly userPath: string
  private readonly maxEntries: number
  private readonly maxContentChars: number
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(options: MemoryStoreOptions) {
    this.projectPath = path.join(options.projectRoot, '.codeden', 'memory.json')
    this.userPath = path.join(options.userHome ?? os.homedir(), '.codeden', 'memory.json')
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
    this.maxContentChars = Math.max(1, options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS)
  }

  async list(scope: MemoryScope | 'all' = 'all'): Promise<MemoryEntry[]> {
    const paths = scope === 'all' ? [this.userPath, this.projectPath] : [this.pathFor(scope)]
    const entries = (await Promise.all(paths.map((filePath) => this.read(filePath)))).flat()
    return entries
      .filter((entry) => entry.scope === 'user' || entry.scope === 'project')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-this.maxEntries)
  }

  async add(
    content: string,
    options: { scope?: MemoryScope; kind?: MemoryKind } = {},
  ): Promise<MemoryEntry> {
    const normalized = content.trim()
    if (!normalized) {
      throw new Error('Memory content must not be empty')
    }
    if (normalized.length > this.maxContentChars) {
      throw new Error(`Memory content exceeds ${this.maxContentChars} characters`)
    }
    if (SECRET_PATTERN.test(normalized)) {
      throw new Error('Memory content appears to contain a secret and was rejected')
    }
    const now = new Date().toISOString()
    const entry: MemoryEntry = {
      id: randomUUID(),
      scope: options.scope ?? 'project',
      kind: options.kind ?? 'fact',
      content: normalized,
      createdAt: now,
      updatedAt: now,
    }
    const filePath = this.pathFor(entry.scope)
    const write = this.pendingWrite.then(async () => {
      const entries = (await this.read(filePath)).filter((item) => item.id !== entry.id)
      entries.push(entry)
      await this.write(filePath, entries.slice(-this.maxEntries))
    })
    this.pendingWrite = write.catch(() => undefined)
    await write
    return entry
  }

  async clear(scope: MemoryScope | 'all' = 'all'): Promise<void> {
    const paths = scope === 'all' ? [this.projectPath, this.userPath] : [this.pathFor(scope)]
    const clear = this.pendingWrite.then(async () => {
      await Promise.all(paths.map((filePath) => rm(filePath, { force: true })))
    })
    this.pendingWrite = clear.catch(() => undefined)
    await clear
  }

  private pathFor(scope: MemoryScope): string {
    return scope === 'project' ? this.projectPath : this.userPath
  }

  private async read(filePath: string): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        return []
      }
      return parsed.filter(isMemoryEntry).slice(-this.maxEntries)
    } catch (error) {
      if (isMissing(error)) {
        return []
      }
      throw error
    }
  }

  private async write(filePath: string, entries: MemoryEntry[]): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, filePath)
  }
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    (item.scope === 'project' || item.scope === 'user') &&
    (item.kind === 'preference' || item.kind === 'fact' || item.kind === 'decision') &&
    typeof item.content === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string'
  )
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
