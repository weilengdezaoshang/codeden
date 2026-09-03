import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { RunEventSchema, type RunEvent } from '@codeden/core/events/run-event.js'
import type { SecretLeakGuard } from '@codeden/core/security/secret-leak-guard.js'
import { EvalRunSchema, parseEvalRun, type EvalRun } from '../../domain/eval-run.js'
import { parseTrialResult, TrialResultSchema, type TrialResult } from '../../domain/trial-result.js'
import type { EvalRepository } from '../../ports/eval-repository.port.js'

const JsonlRecordSchema = z.discriminatedUnion('recordType', [
  z.object({ recordType: z.literal('run'), data: EvalRunSchema }),
  z.object({ recordType: z.literal('event'), data: RunEventSchema }),
  z.object({ recordType: z.literal('trial'), data: TrialResultSchema }),
])

type JsonlRecord = z.infer<typeof JsonlRecordSchema>

export class JsonlEvalRepository implements EvalRepository {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly guard?: SecretLeakGuard,
  ) {}

  async createRun(run: EvalRun): Promise<void> {
    const parsed = parseEvalRun(run)
    this.guard?.assertSafe(parsed, `run:${parsed.runId}`)
    await this.enqueue(async () => {
      await mkdir(this.root, { recursive: true })
      await writeFile(this.runPath(parsed.runId), serialize({ recordType: 'run', data: parsed }), {
        flag: 'wx',
      })
    })
  }

  async updateRun(run: EvalRun): Promise<void> {
    const parsed = parseEvalRun(run)
    this.guard?.assertSafe(parsed, `run:${parsed.runId}`)
    await this.enqueue(async () => {
      const records = await this.readRunRecords(parsed.runId, true)
      if (!records.some((record) => record.recordType === 'run')) {
        throw invariant(`Cannot update unknown run: ${parsed.runId}`)
      }
      await appendFile(this.runPath(parsed.runId), serialize({ recordType: 'run', data: parsed }))
    })
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const parsed = RunEventSchema.parse(event)
    this.guard?.assertSafe(parsed, `event:${parsed.type}`)
    await this.enqueue(async () => {
      const records = await this.readRunRecords(parsed.runId)
      const events = records
        .filter((record) => record.recordType === 'event' && record.data.trialId === parsed.trialId)
        .map((record) => record.data as RunEvent)
      const last = events.at(-1)
      if (
        events.some((item) => item.sequence === parsed.sequence) ||
        (last && parsed.sequence <= last.sequence)
      ) {
        throw invariant(`Invalid event sequence ${parsed.sequence} for trial ${parsed.trialId}`)
      }
      await appendFile(this.runPath(parsed.runId), serialize({ recordType: 'event', data: parsed }))
    })
  }

  async saveTrial(result: TrialResult): Promise<void> {
    const parsed = parseTrialResult(result)
    this.guard?.assertSafe(parsed, `trial:${parsed.trialId}`)
    await this.append(parsed.runId, { recordType: 'trial', data: parsed })
  }

  async getRun(runId: string): Promise<EvalRun | null> {
    await this.writeTail
    const records = await this.readRunRecords(runId, true)
    const runs = records.filter((record) => record.recordType === 'run')
    return structuredClone(runs.at(-1)?.data ?? null)
  }

  async getTrial(trialId: string, benchmarkRunId?: string): Promise<TrialResult | null> {
    await this.writeTail
    for (const file of await this.resultFiles()) {
      const records = await this.readFileRecords(file)
      const trial = records
        .filter(
          (record) =>
            record.recordType === 'trial' &&
            record.data.trialId === trialId &&
            (!benchmarkRunId ||
              record.data.runId === benchmarkRunId ||
              record.data.benchmarkRunId === benchmarkRunId),
        )
        .at(-1)
      if (trial?.recordType === 'trial') {
        return structuredClone(trial.data)
      }
    }
    return null
  }

  async getEvents(trialId: string, benchmarkRunId?: string): Promise<RunEvent[]> {
    await this.writeTail
    const events: RunEvent[] = []
    for (const file of await this.resultFiles()) {
      for (const record of await this.readFileRecords(file)) {
        if (
          record.recordType === 'event' &&
          record.data.trialId === trialId &&
          (!benchmarkRunId ||
            record.data.runId === benchmarkRunId ||
            record.data.benchmarkRunId === benchmarkRunId)
        ) {
          events.push(record.data)
        }
      }
    }
    return structuredClone(events.sort((left, right) => left.sequence - right.sequence))
  }

  async listTrials(runId: string): Promise<TrialResult[]> {
    await this.writeTail
    const trials = new Map<string, TrialResult>()
    for (const record of await this.readRunRecords(runId, true)) {
      if (record.recordType === 'trial') {
        trials.set(record.data.trialId, record.data)
      }
    }
    return [...trials.values()].map((trial) => structuredClone(trial))
  }

  private async append(runId: string, record: JsonlRecord): Promise<void> {
    await this.enqueue(() => appendFile(this.runPath(runId), serialize(record)))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation)
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async readRunRecords(runId: string, missingAsEmpty = false): Promise<JsonlRecord[]> {
    try {
      return await this.readFileRecords(this.runPath(runId))
    } catch (error) {
      if (missingAsEmpty && isMissing(error)) {
        return []
      }
      throw error
    }
  }

  private async readFileRecords(filePath: string): Promise<JsonlRecord[]> {
    const raw = await readFile(filePath, 'utf8')
    return raw
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JsonlRecordSchema.parse(JSON.parse(line))
        } catch (error) {
          throw invariant(`Invalid JSONL record in ${filePath} at line ${index + 1}`, error)
        }
      })
  }

  private async resultFiles(): Promise<string[]> {
    try {
      return (await readdir(this.root))
        .filter((file) => file.endsWith('.jsonl'))
        .sort()
        .map((file) => path.join(this.root, file))
    } catch (error) {
      return isMissing(error) ? [] : Promise.reject(error)
    }
  }

  private runPath(runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/u.test(runId)) {
      throw invariant(`Invalid run id: ${runId}`)
    }
    return path.join(this.root, `${runId}.jsonl`)
  }
}

function serialize(record: JsonlRecord): string {
  return `${JSON.stringify(record)}\n`
}

function invariant(message: string, cause?: unknown): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.INTERNAL_INVARIANT_VIOLATION,
    category: 'internal',
    message,
    retryable: false,
    details: cause instanceof Error ? { cause: cause.message } : undefined,
  })
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
