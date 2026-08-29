import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Clock } from '../core/clock.js'
import { SystemClock } from '../core/clock.js'
import {
  parseTraceUploadEnvelope,
  TraceUploadEnvelopeSchema,
  type TraceUploadEnvelope,
} from './trace-upload-envelope.js'
import { assertSafeRelativePath } from '../runtime/workspace/workspace-boundary.js'

const OutboxRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  payload: TraceUploadEnvelopeSchema,
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  nextAttemptAt: z.iso.datetime(),
  lastError: z.string().max(2_000).optional(),
})

export type TraceOutboxRecord = z.infer<typeof OutboxRecordSchema>

export class TraceOutbox {
  private readonly directory: string
  private readonly projectRoot: string
  private pendingOperation: Promise<unknown> = Promise.resolve()

  constructor(
    projectRoot: string,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.projectRoot = projectRoot
    this.directory = path.join(projectRoot, '.codeden', 'telemetry', 'outbox')
  }

  async enqueue(input: TraceUploadEnvelope): Promise<TraceOutboxRecord> {
    return this.serialize(async () => {
      const now = this.clock.now().toISOString()
      const record = OutboxRecordSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        payload: parseTraceUploadEnvelope(input),
        attemptCount: 0,
        createdAt: now,
        nextAttemptAt: now,
      })
      await this.write(record)
      return record
    })
  }

  async listReady(limit = 20): Promise<TraceOutboxRecord[]> {
    return this.serialize(async () => {
      const records = await this.listAll()
      const now = this.clock.now().getTime()
      return records
        .filter((record) => Date.parse(record.nextAttemptAt) <= now)
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
        .slice(0, Math.max(0, Math.floor(limit)))
    })
  }

  async markFailed(id: string, error: string): Promise<TraceOutboxRecord> {
    return this.serialize(async () => {
      const record = await this.read(id)
      const attemptCount = record.attemptCount + 1
      const delayMs = Math.min(60 * 60_000, 1_000 * 2 ** attemptCount)
      const updated = OutboxRecordSchema.parse({
        ...record,
        attemptCount,
        nextAttemptAt: new Date(this.clock.now().getTime() + delayMs).toISOString(),
        lastError: error.slice(0, 2_000),
      })
      await this.write(updated)
      return updated
    })
  }

  async markDelivered(id: string): Promise<void> {
    await this.serialize(async () => {
      await this.assertSafeOutboxPath(id)
      await rm(this.filePath(id), { force: true })
    })
  }

  filePath(id: string): string {
    if (!z.string().uuid().safeParse(id).success) {
      throw new Error('Outbox id must be a UUID')
    }
    return path.join(this.directory, `${id}.json`)
  }

  private async listAll(): Promise<TraceOutboxRecord[]> {
    let entries
    try {
      await assertSafeRelativePath(this.projectRoot, path.join('.codeden', 'telemetry', 'outbox'))
      entries = await readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) {
        return []
      }
      throw error
    }
    const records: TraceOutboxRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue
      }
      const id = entry.name.slice(0, -'.json'.length)
      if (!z.string().uuid().safeParse(id).success) {
        continue
      }
      try {
        records.push(await this.read(id))
      } catch {
        // A corrupt record stays on disk for inspection but cannot block healthy uploads.
      }
    }
    return records
  }

  private async read(id: string): Promise<TraceOutboxRecord> {
    await this.assertSafeOutboxPath(id)
    return OutboxRecordSchema.parse(
      JSON.parse(await readFile(this.filePath(id), 'utf8')) as unknown,
    )
  }

  private async write(record: TraceOutboxRecord): Promise<void> {
    await this.assertSafeOutboxPath(record.id)
    await mkdir(this.directory, { recursive: true })
    const target = this.filePath(record.id)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, target)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pendingOperation.then(operation)
    this.pendingOperation = run.catch(() => undefined)
    return run
  }

  private async assertSafeOutboxPath(id: string): Promise<void> {
    await assertSafeRelativePath(
      this.projectRoot,
      path.join('.codeden', 'telemetry', 'outbox', `${id}.json`),
    )
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
