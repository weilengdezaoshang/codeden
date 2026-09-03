import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, writeFile, link } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Clock } from '@codeden/core/clock.js'
import { SystemClock } from '@codeden/core/clock.js'
import {
  parseTraceUploadEnvelope,
  TraceUploadEnvelopeSchema,
  type TraceUploadEnvelope,
} from './trace-upload-envelope.js'
import { assertSafeRelativePath } from '@codeden/core/filesystem/workspace-boundary.js'

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
const DeliveryReceiptSchema = z
  .object({ traceId: z.string().regex(/^[a-f0-9]{64}$/u), deliveredAt: z.iso.datetime() })
  .strict()

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
        id: traceOutboxId(input.traceId),
        payload: parseTraceUploadEnvelope(input),
        attemptCount: 0,
        createdAt: now,
        nextAttemptAt: now,
      })
      if (await this.isDelivered(input.traceId)) {
        return record
      }
      try {
        const existing = await this.read(record.id)
        if (existing.payload.traceId !== input.traceId) {
          throw new Error('Outbox 身份冲突')
        }
        return existing
      } catch (error) {
        if (!isMissing(error)) {
          throw error
        }
      }
      try {
        await this.write(record, true)
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) {
          throw error
        }
        return this.read(record.id)
      }
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
      let record: TraceOutboxRecord
      try {
        record = await this.read(id)
      } catch (error) {
        if (isMissing(error)) {
          return
        }
        throw error
      }
      const target = this.receiptPath(record.payload.traceId)
      await this.atomicWrite(
        target,
        { traceId: record.payload.traceId, deliveredAt: this.clock.now().toISOString() },
        false,
      )
      await rm(this.filePath(id), { force: true })
    })
  }

  /** 包含等待重试的队列和送达回执，重启不得把同一个 Trace 重新排队。 */
  async contains(traceId: string): Promise<boolean> {
    if (await this.isDelivered(traceId)) {
      return true
    }
    try {
      const record = await this.read(traceOutboxId(traceId))
      if (record.payload.traceId !== traceId) {
        throw new Error('Outbox 身份冲突')
      }
      return true
    } catch (error) {
      if (isMissing(error)) {
        return false
      }
      throw error
    }
  }

  private receiptPath(traceId: string): string {
    return path.join(
      this.projectRoot,
      '.codeden',
      'telemetry',
      'delivered',
      `${traceOutboxId(traceId)}.json`,
    )
  }

  private async isDelivered(traceId: string): Promise<boolean> {
    try {
      const receipt = DeliveryReceiptSchema.parse(await this.readJson(this.receiptPath(traceId)))
      if (receipt.traceId !== traceId) {
        throw new Error('送达回执身份冲突')
      }
      return true
    } catch (error) {
      if (isMissing(error)) {
        return false
      }
      throw error
    }
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
        const record = await this.read(id)
        if (!(await this.isDelivered(record.payload.traceId))) {
          records.push(record)
        }
      } catch {
        // A corrupt record stays on disk for inspection but cannot block healthy uploads.
      }
    }
    return records
  }

  private async read(id: string): Promise<TraceOutboxRecord> {
    await this.assertSafeOutboxPath(id)
    const record = OutboxRecordSchema.parse(await this.readJson(this.filePath(id)))
    if (record.id !== id) {
      throw new Error('Outbox 文件与记录编号不一致')
    }
    return record
  }

  private async write(record: TraceOutboxRecord, exclusive = false): Promise<void> {
    await this.assertSafeOutboxPath(record.id)
    await this.atomicWrite(this.filePath(record.id), record, exclusive)
  }

  private async readJson(target: string): Promise<unknown> {
    await assertSafeRelativePath(this.projectRoot, path.relative(this.projectRoot, target))
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return JSON.parse(await handle.readFile('utf8')) as unknown
    } finally {
      await handle.close()
    }
  }

  private async atomicWrite(target: string, value: unknown, exclusive: boolean): Promise<void> {
    await assertSafeRelativePath(this.projectRoot, path.relative(this.projectRoot, target))
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      if (exclusive) {
        await link(temporary, target)
      } else {
        await rename(temporary, target)
      }
    } finally {
      await rm(temporary, { force: true })
    }
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
  return hasCode(error, 'ENOENT')
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function traceOutboxId(traceId: string): string {
  if (!/^[a-f0-9]{64}$/u.test(traceId)) {
    throw new Error('Trace id 必须为 SHA256')
  }
  const hex = traceId.slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
