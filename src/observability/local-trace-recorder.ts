import { constants } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Clock } from '../core/clock.js'
import { SystemClock } from '../core/clock.js'
import type { EventSink } from '../core/events/event-sink.js'
import { parseRunEvent, type RunEvent, type RunEventSource } from '../core/events/run-event.js'
import type { SecretLeakGuard } from '../security/secret-leak-guard.js'
import type { SecretRedactor } from '../security/secret-redactor.js'
import { assertSafeRelativePath } from '../runtime/workspace/workspace-boundary.js'

const MAX_EVENT_BYTES = 1_000_000
const MAX_TRACE_BYTES = 16_000_000

export class LocalTraceRecorder implements EventSink {
  readonly filePath: string
  private readonly relativeFilePath: string
  private sequence = 0
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      projectRoot: string
      runId: string
      trialId: string
      clock?: Clock
      redactor: SecretRedactor
      guard: SecretLeakGuard
    },
  ) {
    assertSafeId(options.runId, 'runId')
    assertSafeId(options.trialId, 'trialId')
    this.relativeFilePath = path.join('.codeden', 'traces', `${options.runId}.jsonl`)
    this.filePath = path.join(options.projectRoot, this.relativeFilePath)
  }

  async emit(source: RunEventSource, type: string, data: unknown = {}): Promise<void> {
    const event = parseRunEvent({
      schemaVersion: 1,
      runId: this.options.runId,
      trialId: this.options.trialId,
      sequence: this.sequence++,
      timestamp: (this.options.clock ?? new SystemClock()).now().toISOString(),
      source,
      type,
      data: this.options.redactor.redactValue(data),
    })
    this.options.guard.assertSafe(event, `local-trace:${this.options.runId}`)
    const line = JSON.stringify(event) + '\n'
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
      throw new Error(`Trace event exceeds ${MAX_EVENT_BYTES} bytes`)
    }
    const write = this.pendingWrite.then(async () => {
      await assertSafeRelativePath(this.options.projectRoot, this.relativeFilePath)
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const currentSize = await fileSize(this.filePath)
      if (currentSize + Buffer.byteLength(line, 'utf8') > MAX_TRACE_BYTES) {
        throw new Error(`Trace file exceeds ${MAX_TRACE_BYTES} bytes`)
      }
      const handle = await open(
        this.filePath,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.chmod(0o600)
        await handle.writeFile(line, 'utf8')
      } finally {
        await handle.close()
      }
    })
    this.pendingWrite = write.catch(() => undefined)
    await write
  }

  async readAll(): Promise<RunEvent[]> {
    await this.pendingWrite
    let raw: string
    try {
      await assertSafeRelativePath(this.options.projectRoot, this.relativeFilePath)
      const handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        raw = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (isMissing(error)) {
        return []
      }
      throw error
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => parseRunEvent(JSON.parse(line) as unknown))
  }
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
