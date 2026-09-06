import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from '../models/model-types.js'
import type { SessionActivity, SessionTurn } from './agent-session.js'
import type { ApprovalMode } from '../agent/agent-contracts.js'
import type { SecretRedactor } from '@codeden/core/security/secret-redactor.js'

const MAX_SESSION_BYTES = 4_000_000
const FILES = {
  summary: 'summary.json',
  updates: 'updates.jsonl',
  chat: 'chat_history.jsonl',
  settings: 'settings.json',
} as const

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
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** 压缩后的上文摘要；独立保存，保证恢复后再次压缩不会丢失早期上下文。 */
  compactionNote?: string
  /** 不受上下文压缩影响的会话元数据。旧快照可由保留轮次推导。 */
  title?: string
  preview?: string
  totalTurnCount?: number
  cumulativeMetrics?: SessionCumulativeMetrics
  conversation: ModelMessage[]
  turns: SessionTurn[]
  contextTurns?: SessionTurn[]
  createdAt?: string
  recoveryWarnings?: string[]
  updatedAt: string
}

export interface SessionCumulativeMetrics {
  inputTokens: number
  outputTokens: number
  toolCalls: number
  costUsd?: number
  /** 缓存读取/写入累计；仅 provider 实际返回时存在（M4）。 */
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface SessionSummary {
  sessionId: string
  title: string
  preview: string
  turnCount: number
  updatedAt: string
}

interface PersistedSummary extends SessionSummary {
  schemaVersion: 1
  commitId: string
  generationTurnCount: number
  createdAt: string
  inputTokens: number
  outputTokens: number
  toolCalls: number
  costUsd?: number
  pendingTurn?: { turnId: string; prompt: string; startedAt: number }
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
    const directory = this.sessionDirectory(sessionId)
    try {
      const records = await readRecords(path.join(directory, FILES.chat))
      const updateRecords = await readRecords(path.join(directory, FILES.updates))
      let summary: PersistedSummary
      try {
        summary = await readSummary(path.join(directory, FILES.summary))
      } catch (error) {
        if (isMissing(error) && records.length === 0 && updateRecords.length === 0) {
          return undefined
        }
        summary = recoverSummary(records, updateRecords)
        await this.atomicJson(path.join(directory, FILES.summary), summary)
      }
      const committedRecord = [...records]
        .reverse()
        .find(
          (record) => isRecord(record.payload) && record.payload.commitId === summary.commitId,
        )?.payload
      const latest = isRecord(committedRecord) ? committedRecord.snapshot : undefined
      if (!isSnapshot(latest) || latest.sessionId !== sessionId) {
        throw new Error(
          `Session ${sessionId} is corrupted: committed snapshot is missing or invalid`,
        )
      }
      const committedUpdates = updateRecords.filter(
        (record) => isRecord(record.payload) && record.payload.commitId === summary.commitId,
      )
      if (committedUpdates.length !== summary.generationTurnCount) {
        throw new Error('Committed session generation is incomplete')
      }
      const restoredTurns = committedUpdates.map((record, index) => {
        const payload = record.payload
        if (
          !isRecord(payload) ||
          payload.type !== 'turn_completed' ||
          !isSessionTurn(payload.turn)
        ) {
          throw new Error(`Invalid session update at sequence ${index + 1}`)
        }
        return payload.turn
      })
      const committedTurns = restoredTurns
      const loadedSettings = await readSettings(
        path.join(directory, FILES.settings),
        summary.commitId,
      )
      const restored: SessionSnapshot = {
        ...latest,
        ...loadedSettings.value,
        turns: [
          ...committedTurns,
          ...(summary.pendingTurn ? [interruptedTurn(summary.pendingTurn)] : []),
        ],
        totalTurnCount: latest.totalTurnCount ?? summary.turnCount,
        cumulativeMetrics: latest.cumulativeMetrics ?? {
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          toolCalls: summary.toolCalls,
          ...(summary.costUsd === undefined ? {} : { costUsd: summary.costUsd }),
        },
        permissionMode: loadedSettings.value.permissionMode ?? latest.permissionMode ?? 'ask',
        recoveryWarnings: loadedSettings.warning ? [loadedSettings.warning] : undefined,
      }
      return restored
    } catch (error) {
      if (isMissing(error)) {
        return undefined
      }
      throw error
    }
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    const write = this.pendingWrite.then(async () => {
      const directory = this.sessionDirectory(snapshot.sessionId)
      await mkdir(directory, { recursive: true })
      const chatPath = path.join(directory, FILES.chat)
      const updatePath = path.join(directory, FILES.updates)
      const chatRecords = await readRecords(chatPath)
      const updateRecords = await readRecords(updatePath)
      const commitId = randomUUID()
      for (const [index, turn] of snapshot.turns.entries()) {
        await this.appendRecord(updatePath, updateRecords.length + index + 1, {
          commitId,
          type: 'turn_completed',
          turn,
        })
      }
      await this.appendRecord(chatPath, chatRecords.length + 1, {
        ...chatPayload(snapshot, commitId),
      })
      await this.atomicJson(path.join(directory, FILES.settings), {
        schemaVersion: 1,
        commitId,
        nextTurn: snapshot.nextTurn,
        planMode: snapshot.planMode,
        persona: snapshot.persona,
        activeSkill: snapshot.activeSkill,
        permissionMode: snapshot.permissionMode ?? 'ask',
        provider: snapshot.provider,
        model: snapshot.model,
        reasoningEffort: snapshot.reasoningEffort,
      })
      await this.atomicJson(path.join(directory, FILES.summary), summaryOf(snapshot, commitId))
      try {
        await this.writeRecords(
          updatePath,
          snapshot.turns.map((turn) => ({ commitId, type: 'turn_completed', turn })),
        )
        await this.writeRecords(chatPath, [chatPayload(snapshot, commitId)])
      } catch (error) {
        if (snapshot.turns.length === 0) {
          throw error
        }
        // Compaction is best-effort after summary.json atomically commits the generation.
      }
    })
    this.pendingWrite = write.catch(() => undefined)
    await write
  }

  async startTurn(
    sessionId: string,
    turnId: string,
    prompt: string,
    startedAt: number,
  ): Promise<void> {
    const write = this.pendingWrite.then(async () => {
      const directory = this.sessionDirectory(sessionId)
      const summaryPath = path.join(directory, FILES.summary)
      const summary = await readSummary(summaryPath)
      await this.atomicJson(summaryPath, {
        ...summary,
        pendingTurn: { turnId, prompt, startedAt },
      })
    })
    this.pendingWrite = write.catch(() => undefined)
    await write
  }

  async clear(sessionId: string): Promise<void> {
    const clear = this.pendingWrite.then(async () => {
      const source = this.sessionDirectory(sessionId)
      await rm(source, { recursive: true, force: true })
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
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
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
          const value: unknown = JSON.parse(
            await readFile(path.join(this.sessionDirectory(sessionId), FILES.summary), 'utf8'),
          )
          return isSummary(value)
            ? {
                sessionId: value.sessionId,
                title: value.title,
                preview: value.preview,
                turnCount: value.turnCount,
                updatedAt: value.updatedAt,
              }
            : undefined
        } catch {
          try {
            const recovered = await this.load(sessionId)
            return recovered
              ? {
                  sessionId,
                  title: recovered.title ?? '新会话',
                  preview: recovered.preview ?? '尚未开始对话',
                  turnCount: recovered.totalTurnCount ?? recovered.turns.length,
                  updatedAt: recovered.updatedAt,
                }
              : undefined
          } catch {
            // A corrupted history item should not prevent the remaining sessions from loading.
            return undefined
          }
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

  private sessionDirectory(sessionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(sessionId)) {
      throw new Error('Session id must contain only letters, numbers, dot, underscore, or dash')
    }
    return path.join(this.directory, sessionId)
  }

  private async appendRecord(filePath: string, sequence: number, payload: unknown): Promise<void> {
    const line = this.serialize({
      schemaVersion: 1,
      sequence,
      timestamp: new Date().toISOString(),
      payload,
    })
    await appendFile(filePath, `${line}\n`, { mode: 0o600 })
  }

  private async atomicJson(filePath: string, value: unknown): Promise<void> {
    await this.atomicWrite(filePath, `${this.serialize(value)}\n`)
  }

  private async writeRecords(filePath: string, payloads: readonly unknown[]): Promise<void> {
    const timestamp = new Date().toISOString()
    const lines = payloads.map((payload, index) =>
      this.serialize({ schemaVersion: 1, sequence: index + 1, timestamp, payload }),
    )
    await this.atomicWrite(filePath, lines.length ? `${lines.join('\n')}\n` : '')
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, filePath)
  }

  private serialize(value: unknown): string {
    const bounded = boundPersistentValue(value)
    const serialized = JSON.stringify(bounded)
    const safe = this.redactor?.redact(serialized) ?? serialized
    if (Buffer.byteLength(safe, 'utf8') > MAX_SESSION_BYTES) {
      throw new Error(`Session record exceeds ${MAX_SESSION_BYTES} bytes`)
    }
    return safe
  }
}

function boundPersistentValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const limit = 64_000
    return value.length > limit
      ? `${value.slice(0, limit)}… [truncated ${value.length - limit} chars]`
      : value
  }
  if (depth > 20 || value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 2_000).map((item) => boundPersistentValue(item, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, boundPersistentValue(item, depth + 1)]),
  )
}

interface StoredRecord {
  schemaVersion: 1
  sequence: number
  timestamp: string
  payload: unknown
}

async function readRecords(filePath: string): Promise<StoredRecord[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return []
    }
    throw error
  }
  const lines = raw.split('\n')
  const trailingNewline = raw.endsWith('\n')
  const records: StoredRecord[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      if (index === lines.length - 1 && !trailingNewline) {
        break
      }
      throw new Error(`Corrupted session log ${path.basename(filePath)} at line ${index + 1}`)
    }
    if (!isStoredRecord(value, records.length + 1)) {
      throw new Error(`Invalid session sequence in ${path.basename(filePath)} at line ${index + 1}`)
    }
    records.push(value)
  }
  return records
}

async function readSettings(
  filePath: string,
  expectedCommitId: string,
): Promise<{ value: Partial<SessionSnapshot>; warning?: string }> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (isRecord(value) && typeof value.schemaVersion === 'number' && value.schemaVersion > 1) {
      throw new UnsupportedSettingsVersionError(value.schemaVersion)
    }
    if (!isRecord(value) || value.schemaVersion !== 1) {
      return {
        value: { permissionMode: 'ask', planMode: false },
        warning: '会话设置无效，已使用安全默认值。',
      }
    }
    if (value.commitId !== expectedCommitId) {
      return {
        value: {},
        warning: '会话设置未完整提交，已恢复上一份已提交设置。',
      }
    }
    return {
      value: {
        nextTurn: typeof value.nextTurn === 'number' ? value.nextTurn : 1,
        planMode: typeof value.planMode === 'boolean' ? value.planMode : false,
        persona: typeof value.persona === 'string' ? value.persona : '',
        activeSkill: typeof value.activeSkill === 'string' ? value.activeSkill : '',
        permissionMode: value.permissionMode === 'auto' ? 'auto' : 'ask',
        provider: typeof value.provider === 'string' ? value.provider : undefined,
        model: typeof value.model === 'string' ? value.model : undefined,
        reasoningEffort:
          value.reasoningEffort === 'low' ||
          value.reasoningEffort === 'medium' ||
          value.reasoningEffort === 'high'
            ? value.reasoningEffort
            : undefined,
      },
    }
  } catch (error) {
    if (error instanceof UnsupportedSettingsVersionError) {
      throw error
    }
    return {
      value: { permissionMode: 'ask', planMode: false },
      warning: '会话设置损坏，已使用安全默认值。',
    }
  }
}

class UnsupportedSettingsVersionError extends Error {
  constructor(version: number) {
    super(`Unsupported session settings schema version: ${version}`)
  }
}

async function readSummary(filePath: string): Promise<PersistedSummary> {
  const value: unknown = JSON.parse(await readFile(filePath, 'utf8'))
  if (!isSummary(value)) {
    throw new Error('Unsupported or invalid session summary')
  }
  return value
}

function recoverSummary(
  chatRecords: readonly StoredRecord[],
  updateRecords: readonly StoredRecord[],
): PersistedSummary {
  for (const record of [...chatRecords].reverse()) {
    const payload = record.payload
    if (!isRecord(payload) || typeof payload.commitId !== 'string') {
      continue
    }
    const snapshot = payload.snapshot
    if (!isSnapshot(snapshot)) {
      continue
    }
    const committed = updateRecords.filter(
      (update) => isRecord(update.payload) && update.payload.commitId === payload.commitId,
    )
    if (committed.length === payload.turnCount) {
      const turns = committed
        .map((update) => (isRecord(update.payload) ? update.payload.turn : undefined))
        .filter(isSessionTurn)
      return summaryOf({ ...snapshot, turns, totalTurnCount: turns.length }, payload.commitId)
    }
  }
  throw new Error('Session summary is damaged and no complete generation can be recovered')
}

function chatPayload(snapshot: SessionSnapshot, commitId: string): Record<string, unknown> {
  return {
    commitId,
    type: 'context_snapshot',
    turnCount: snapshot.turns.length,
    snapshot: { ...snapshot, turns: [] },
  }
}

function summaryOf(snapshot: SessionSnapshot, commitId: string): PersistedSummary {
  const metrics = snapshot.cumulativeMetrics ?? {
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
  }
  return {
    schemaVersion: 1,
    commitId,
    sessionId: snapshot.sessionId,
    title: snapshot.title?.trim() || snapshot.turns[0]?.prompt.trim() || '新会话',
    preview: snapshot.preview?.trim() || snapshot.turns.at(-1)?.prompt.trim() || '尚未开始对话',
    turnCount: snapshot.totalTurnCount ?? snapshot.turns.length,
    generationTurnCount: snapshot.turns.length,
    createdAt: snapshot.createdAt ?? snapshot.updatedAt,
    updatedAt: snapshot.updatedAt,
    ...metrics,
  }
}

function isSummary(value: unknown): value is PersistedSummary {
  if (!isRecord(value)) {
    return false
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.commitId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.preview === 'string' &&
    typeof value.turnCount === 'number' &&
    typeof value.generationTurnCount === 'number' &&
    typeof value.updatedAt === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.toolCalls === 'number' &&
    (value.pendingTurn === undefined ||
      (isRecord(value.pendingTurn) &&
        typeof value.pendingTurn.turnId === 'string' &&
        typeof value.pendingTurn.prompt === 'string' &&
        typeof value.pendingTurn.startedAt === 'number'))
  )
}

function isStoredRecord(value: unknown, sequence: number): value is StoredRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.sequence === sequence &&
    typeof value.timestamp === 'string' &&
    'payload' in value
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
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
    (item.reasoningEffort === undefined ||
      item.reasoningEffort === 'low' ||
      item.reasoningEffort === 'medium' ||
      item.reasoningEffort === 'high') &&
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
    (item.contextTurns === undefined ||
      (Array.isArray(item.contextTurns) && item.contextTurns.every(isSessionTurn))) &&
    (item.createdAt === undefined || typeof item.createdAt === 'string') &&
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

function interruptedTurn(start: {
  turnId: string
  prompt: string
  startedAt: number
}): SessionTurn {
  return {
    turnId: start.turnId,
    prompt: start.prompt,
    startedAt: start.startedAt,
    completedAt: start.startedAt,
    result: {
      status: 'agent_error',
      stopReason: 'interrupted',
      finalResponse: '上次运行在完成前中断。',
      metrics: {
        durationMs: 0,
        turns: 0,
        modelRequests: 0,
        toolCalls: 0,
        toolFailures: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  }
}

function isSessionTurn(value: unknown): value is SessionTurn {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    (item.turnId === undefined || typeof item.turnId === 'string') &&
    typeof item.prompt === 'string' &&
    typeof item.startedAt === 'number' &&
    typeof item.completedAt === 'number' &&
    isAgentRunResult(item.result) &&
    (!('activities' in item) ||
      (Array.isArray(item.activities) && item.activities.every(isSessionActivity)))
  )
}

function isAgentRunResult(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.metrics)) {
    return false
  }
  return (
    (value.status === 'submitted' ||
      value.status === 'verified_complete' ||
      value.status === 'timeout' ||
      value.status === 'budget_exhausted' ||
      value.status === 'agent_error') &&
    typeof value.finalResponse === 'string' &&
    (value.stopReason === undefined || typeof value.stopReason === 'string') &&
    (value.turnTranscript === undefined ||
      (Array.isArray(value.turnTranscript) && value.turnTranscript.every(isModelMessage)))
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
