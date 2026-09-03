import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, open, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Clock } from '@codeden/core/clock.js'
import { SystemClock } from '@codeden/core/clock.js'
import type { EventSink } from '@codeden/core/events/event-sink.js'
import {
  parseRunEvent,
  type RunEvent,
  type RunEventSource,
} from '@codeden/core/events/run-event.js'
import type { SecretLeakGuard } from '@codeden/core/security/secret-leak-guard.js'
import type { SecretRedactor } from '@codeden/core/security/secret-redactor.js'
import { assertSafeRelativePath } from '@codeden/core/filesystem/workspace-boundary.js'
import { TrialMetricsSchema } from '@codeden/core/metrics.js'
import { readTraceEvents, isRootTraceData } from './trace-file-reader.js'

const MAX_EVENT_BYTES = 1_000_000
const MAX_TRACE_BYTES = 16_000_000
const MAX_DELTA_CHARS = 256_000

export class LocalTraceRecorder implements EventSink {
  readonly filePath: string
  private readonly relativeFilePath: string
  private sequence = 0
  private pendingWrite: Promise<void> = Promise.resolve()
  private pendingDelta = ''
  private pendingDeltaChunks = 0
  private pendingDeltaTruncated = false
  private pendingDeltaScope: Record<string, unknown> = {}
  private readonly requestStates = new Map<
    string,
    { count: number; digest: string; toolsDigest: string }
  >()
  private traceTruncated = false
  private completed = false

  constructor(
    private readonly options: {
      projectRoot: string
      runId: string
      trialId: string
      clock?: Clock
      redactor: SecretRedactor
      guard: SecretLeakGuard
      maxEventBytes?: number
      maxTraceBytes?: number
    },
  ) {
    assertSafeId(options.runId, 'runId')
    assertSafeId(options.trialId, 'trialId')
    for (const limit of [options.maxEventBytes, options.maxTraceBytes]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 2000)) {
        throw new Error('Trace 字节上限至少为 2000，以保留终态和计量')
      }
    }
    this.relativeFilePath = path.join('.codeden', 'traces', `${options.runId}.jsonl`)
    this.filePath = path.join(options.projectRoot, this.relativeFilePath)
  }

  async emit(source: RunEventSource, type: string, data: unknown = {}): Promise<void> {
    const operation = this.pendingWrite.then(async () => {
      if (this.completed) {
        return
      }
      if (source === 'model' && type === 'model.text_delta') {
        const scope = isRecord(data)
          ? { agentSpanId: data.agentSpanId, agentDepth: data.agentDepth }
          : {}
        if (digest(scope) !== digest(this.pendingDeltaScope)) {
          await this.flushDelta()
        }
        this.pendingDeltaScope = scope
        this.collectDelta(data)
        return
      }
      await this.flushDelta()
      await this.writeEvent(source, type, this.normalizeData(type, data))
    })
    this.pendingWrite = operation.catch(() => undefined)
    return operation
  }

  async readAll(): Promise<RunEvent[]> {
    const operation = this.pendingWrite.then(() => this.readEvents())
    this.pendingWrite = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async readEvents(): Promise<RunEvent[]> {
    await this.flushDelta()
    try {
      return await readTraceEvents(
        this.options.projectRoot,
        this.relativeFilePath,
        this.options.maxTraceBytes ?? MAX_TRACE_BYTES,
      )
    } catch (error) {
      if (isMissing(error)) {
        return []
      }
      throw error
    }
  }

  private collectDelta(data: unknown): void {
    const delta = readString(data, 'delta')
    if (!delta) {
      return
    }
    this.pendingDeltaChunks += 1
    const remaining = Math.max(0, MAX_DELTA_CHARS - this.pendingDelta.length)
    this.pendingDelta += delta.slice(0, remaining)
    this.pendingDeltaTruncated ||= delta.length > remaining
  }

  private async flushDelta(): Promise<void> {
    if (this.pendingDeltaChunks === 0) {
      return
    }
    const data = {
      ...this.pendingDeltaScope,
      delta: this.pendingDelta,
      chunkCount: this.pendingDeltaChunks,
      truncated: this.pendingDeltaTruncated,
    }
    this.pendingDelta = ''
    this.pendingDeltaChunks = 0
    this.pendingDeltaTruncated = false
    await this.writeEvent('model', 'model.text_delta', data)
  }

  private normalizeData(type: string, data: unknown): unknown {
    const safe = this.options.redactor.redactValue(data)
    if (type !== 'model.requested' || !isRecord(safe)) {
      return safe
    }
    const messages = Array.isArray(safe.messages) ? safe.messages : []
    const tools = Array.isArray(safe.tools) ? safe.tools : []
    const scope = readString(safe, 'agentSpanId') || 'root'
    const previous = this.requestStates.get(scope)
    const first =
      !previous ||
      messages.length < previous.count ||
      digest(messages.slice(0, previous.count)) !== previous.digest
    const messagesAdded = first ? messages : messages.slice(previous.count)
    const toolsDigest = digest(tools)
    this.requestStates.set(scope, { count: messages.length, digest: digest(messages), toolsDigest })
    return {
      agentSpanId: safe.agentSpanId,
      agentDepth: safe.agentDepth,
      turn: safe.turn,
      messageCount: messages.length,
      messagesDigest: digest(messages),
      ...(first ? { messages } : { messagesAdded }),
      toolCount: tools.length,
      toolsDigest,
      ...(first || previous?.toolsDigest !== toolsDigest
        ? { tools }
        : { toolNames: tools.map(readToolName).filter(Boolean) }),
    }
  }

  private async writeEvent(source: RunEventSource, type: string, data: unknown): Promise<void> {
    await assertSafeRelativePath(this.options.projectRoot, this.relativeFilePath)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const maxEventBytes = this.options.maxEventBytes ?? MAX_EVENT_BYTES
    const maxTraceBytes = this.options.maxTraceBytes ?? MAX_TRACE_BYTES
    const currentSize = await fileSize(this.filePath)
    const rootTerminal = type === 'agent.completed' && isRootTraceData(data)
    let event = this.createEvent(source, type, data)
    let line = JSON.stringify(event) + '\n'
    let lineBytes = Buffer.byteLength(line, 'utf8')
    const eventLimit = rootTerminal
      ? Math.min(maxEventBytes, maxTraceBytes - currentSize, 64_000)
      : maxEventBytes
    if (lineBytes > eventLimit) {
      event = this.createEvent(
        source,
        type,
        rootTerminal ? compactTerminal(event.data, lineBytes) : compactData(event.data, lineBytes),
      )
      line = JSON.stringify(event) + '\n'
      lineBytes = Buffer.byteLength(line, 'utf8')
    }
    const reserveBytes = Math.min(64_000, Math.max(2048, Math.floor(maxTraceBytes / 4)))
    const softLimit = Math.max(0, maxTraceBytes - reserveBytes)
    if (!isCritical(type, data) && currentSize + lineBytes > softLimit) {
      if (!this.traceTruncated) {
        this.traceTruncated = true
        await this.writeEvent('agent', 'trace.truncated', {
          reason: 'trace_size_limit',
          maxTraceBytes,
        })
      }
      return
    }
    if (currentSize + lineBytes > maxTraceBytes || lineBytes > maxEventBytes) {
      if (rootTerminal) {
        throw new Error('无法在 Trace 容量内保留终态')
      }
      return
    }
    this.options.guard.assertSafe(event, `local-trace:${this.options.runId}`)
    const handle = await open(
      this.filePath,
      (this.sequence === 0 ? constants.O_CREAT | constants.O_EXCL : constants.O_APPEND) |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.chmod(0o600)
      await handle.writeFile(line, 'utf8')
      this.sequence += 1
      if (rootTerminal) {
        this.completed = true
      }
    } finally {
      await handle.close()
    }
  }

  private createEvent(source: RunEventSource, type: string, data: unknown): RunEvent {
    return parseRunEvent({
      schemaVersion: 1,
      runId: this.options.runId,
      trialId: this.options.trialId,
      sequence: this.sequence,
      timestamp: (this.options.clock ?? new SystemClock()).now().toISOString(),
      source,
      type,
      data: this.options.redactor.redactValue(data),
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : ''
}

function readToolName(value: unknown): string {
  return isRecord(value) && typeof value.name === 'string' ? value.name : ''
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function compactData(data: unknown, originalBytes: number): unknown {
  return {
    ...(isRecord(data)
      ? { agentDepth: data.agentDepth, agentSpanId: readString(data, 'agentSpanId').slice(0, 128) }
      : {}),
    truncated: true,
    originalBytes,
    dataDigest: digest(data),
  }
}

function compactTerminal(data: unknown, originalBytes: number): unknown {
  const value = isRecord(data) ? data : {}
  const metrics = TrialMetricsSchema.safeParse(value.metrics)
  return {
    ...(compactData(data, originalBytes) as Record<string, unknown>),
    status: readString(value, 'status').slice(0, 64),
    ...(metrics.success ? { metrics: metrics.data } : {}),
    ...(typeof value.captureConsentDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.captureConsentDigest)
      ? { captureConsentDigest: value.captureConsentDigest }
      : {}),
  }
}

function isCritical(type: string, data: unknown): boolean {
  return (
    (type === 'agent.completed' && (!isRecord(data) || !data.agentDepth)) ||
    type === 'trace.truncated' ||
    type === 'eval.trial.completed'
  )
}

function assertSafeId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${name} contains unsafe characters`)
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size
  } catch (error) {
    if (isMissing(error)) {
      return 0
    }
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
