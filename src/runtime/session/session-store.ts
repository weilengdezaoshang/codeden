import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from '../models/model-types.js'
import type { SessionTurn } from './agent-session.js'
import type { SecretRedactor } from '../../security/secret-redactor.js'

export interface SessionSnapshot {
  schemaVersion: 1
  sessionId: string
  nextTurn: number
  planMode: boolean
  persona: string
  activeSkill: string
  conversation: ModelMessage[]
  turns: SessionTurn[]
  updatedAt: string
}

export class SessionStore {
  private readonly directory: string
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(
    projectRoot: string,
    private readonly redactor?: SecretRedactor,
  ) {
    this.directory = path.join(projectRoot, '.codeden', 'sessions')
  }

  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    try {
      const raw = await readFile(this.filePath(sessionId), 'utf8')
      const value: unknown = JSON.parse(raw)
      return isSnapshot(value) && value.sessionId === sessionId ? value : undefined
    } catch (error) {
      if (isMissing(error)) {
        return undefined
      }
      throw error
    }
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    const write = this.pendingWrite.then(async () => {
      await mkdir(this.directory, { recursive: true })
      const filePath = this.filePath(snapshot.sessionId)
      const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
      const serialized = JSON.stringify(snapshot, null, 2)
      const safe = this.redactor?.redact(serialized) ?? serialized
      await writeFile(temporary, safe + '\n', { mode: 0o600 })
      await rename(temporary, filePath)
    })
    this.pendingWrite = write.catch(() => undefined)
    await write
  }

  async clear(sessionId: string): Promise<void> {
    const clear = this.pendingWrite.then(async () => {
      await rm(this.filePath(sessionId), { force: true })
    })
    this.pendingWrite = clear.catch(() => undefined)
    await clear
  }

  private filePath(sessionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(sessionId)) {
      throw new Error('Session id must contain only letters, numbers, dot, underscore, or dash')
    }
    return path.join(this.directory, `${sessionId}.json`)
  }
}

function isSnapshot(value: unknown): value is SessionSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    item.schemaVersion === 1 &&
    typeof item.sessionId === 'string' &&
    typeof item.nextTurn === 'number' &&
    Number.isSafeInteger(item.nextTurn) &&
    item.nextTurn > 0 &&
    typeof item.planMode === 'boolean' &&
    typeof item.persona === 'string' &&
    typeof item.activeSkill === 'string' &&
    Array.isArray(item.conversation) &&
    item.conversation.every(isModelMessage) &&
    Array.isArray(item.turns) &&
    item.turns.every(isSessionTurn) &&
    typeof item.updatedAt === 'string'
  )
}

function isSessionTurn(value: unknown): value is SessionTurn {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    typeof item.prompt === 'string' &&
    typeof item.startedAt === 'number' &&
    typeof item.completedAt === 'number' &&
    typeof item.result === 'object' &&
    item.result !== null
  )
}

function isModelMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    (item.role === 'system' ||
      item.role === 'user' ||
      item.role === 'assistant' ||
      item.role === 'tool') &&
    typeof item.content === 'string'
  )
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
