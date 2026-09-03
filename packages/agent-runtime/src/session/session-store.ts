import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from '../models/model-types.js'
import type { SessionActivity, SessionTurn } from './agent-session.js'
import type { ApprovalMode } from '../agent/agent-contracts.js'
import type { SecretRedactor } from '@codeden/core/security/secret-redactor.js'

const MAX_SESSION_BYTES = 4_000_000

export interface SessionSnapshot {
  schemaVersion: 1
  sessionId: string
  nextTurn: number
  planMode: boolean
  persona: string
  activeSkill: string
  permissionMode?: ApprovalMode
  provider?: string
  model?: string
  /** 压缩后的上文摘要；独立保存，保证恢复后再次压缩不会丢失早期上下文。 */
  compactionNote?: string
  /** 不受上下文压缩影响的会话元数据。旧快照可由保留轮次推导。 */
  title?: string
  preview?: string
  totalTurnCount?: number
  cumulativeMetrics?: SessionCumulativeMetrics
  conversation: ModelMessage[]
  turns: SessionTurn[]
  updatedAt: string
}

export interface SessionCumulativeMetrics {
  inputTokens: number
  outputTokens: number
  toolCalls: number
  costUsd?: number
}

export interface SessionSummary {
  sessionId: string
  title: string
  preview: string
  turnCount: number
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
      if (Buffer.byteLength(safe, 'utf8') > MAX_SESSION_BYTES) {
        throw new Error(`Session snapshot exceeds ${MAX_SESSION_BYTES} bytes`)
      }
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

  async flush(): Promise<void> {
    await this.pendingWrite
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length))
        .filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id))
        .sort()
    } catch (error) {
      if (isMissing(error)) {
        return []
      }
      throw error
    }
  }

  async listSummaries(): Promise<SessionSummary[]> {
    const snapshots = await Promise.all(
      (await this.list()).map(async (sessionId) => {
        try {
          const snapshot = await this.load(sessionId)
          if (!snapshot) {
            return undefined
          }
          const firstPrompt = snapshot.title?.trim() || snapshot.turns[0]?.prompt.trim()
          const lastPrompt = snapshot.preview?.trim() || snapshot.turns.at(-1)?.prompt.trim()
          return {
            sessionId,
            title: firstPrompt || '新会话',
            preview: lastPrompt || '尚未开始对话',
            turnCount: snapshot.totalTurnCount ?? snapshot.turns.length,
            updatedAt: snapshot.updatedAt,
          }
        } catch {
          // A corrupted history item should not prevent the remaining sessions from loading.
          return undefined
        }
      }),
    )
    return snapshots
      .filter((summary): summary is SessionSummary => summary !== undefined)
      .sort((left, right) => {
        const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt)
        return byUpdatedAt || left.sessionId.localeCompare(right.sessionId)
      })
  }

  async latestSessionId(): Promise<string | undefined> {
    return (await this.listSummaries())[0]?.sessionId
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
    (item.permissionMode === undefined ||
      item.permissionMode === 'ask' ||
      item.permissionMode === 'auto') &&
    (item.provider === undefined || typeof item.provider === 'string') &&
    (item.model === undefined || typeof item.model === 'string') &&
    (item.compactionNote === undefined || typeof item.compactionNote === 'string') &&
    (item.title === undefined || typeof item.title === 'string') &&
    (item.preview === undefined || typeof item.preview === 'string') &&
    (item.totalTurnCount === undefined ||
      (typeof item.totalTurnCount === 'number' &&
        Number.isSafeInteger(item.totalTurnCount) &&
        item.totalTurnCount >= 0)) &&
    (item.cumulativeMetrics === undefined || isCumulativeMetrics(item.cumulativeMetrics)) &&
    Array.isArray(item.conversation) &&
    item.conversation.every(isModelMessage) &&
    Array.isArray(item.turns) &&
    item.turns.every(isSessionTurn) &&
    typeof item.updatedAt === 'string'
  )
}

function isCumulativeMetrics(value: unknown): value is SessionCumulativeMetrics {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    isNonNegativeNumber(item.inputTokens) &&
    isNonNegativeNumber(item.outputTokens) &&
    isNonNegativeNumber(item.toolCalls) &&
    (item.costUsd === undefined || isNonNegativeNumber(item.costUsd))
  )
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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
    item.result !== null &&
    (!('activities' in item) ||
      (Array.isArray(item.activities) && item.activities.every(isSessionActivity)))
  )
}

function isSessionActivity(value: unknown): value is SessionActivity {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    (item.kind === 'thinking' || item.kind === 'tool' || item.kind === 'verification') &&
    typeof item.label === 'string' &&
    (item.status === 'running' || item.status === 'completed' || item.status === 'failed') &&
    (item.durationMs === undefined ||
      (typeof item.durationMs === 'number' && Number.isFinite(item.durationMs)))
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
