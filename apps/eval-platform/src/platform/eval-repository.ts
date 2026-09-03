import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { EvalRepository } from '@codeden/eval-engine/ports/eval-repository.port.js'
import type { EvalRun } from '@codeden/eval-engine/domain/eval-run.js'
import type { TrialResult } from '@codeden/eval-engine/domain/trial-result.js'
import type { RunEvent } from '@codeden/core/events/run-event.js'
import type { SecurityServices } from '@codeden/core/security/security-services.js'
import type { Database } from './database.js'
import { benchmarkRuns, jobs, trials, events } from './schema.js'

/** 引擎的仓储适配器：进度与单条结果在同一事务内提交。 */
export class PlatformEvalRepository implements EvalRepository {
  constructor(
    private readonly db: Database,
    private readonly jobId: string,
    private readonly security: SecurityServices,
    private readonly benchmarkRunId?: string,
  ) {}
  async createRun(run: EvalRun) {
    await this.updateRun(run)
  }
  async updateRun(run: EvalRun) {
    const safe = this.safe(run)
    if (this.benchmarkRunId) {
      await this.db
        .update(benchmarkRuns)
        .set({ run: safe })
        .where(and(eq(benchmarkRuns.id, this.benchmarkRunId), eq(benchmarkRuns.jobId, this.jobId)))
      return
    }
    await this.db
      .update(jobs)
      .set({ run: safe })
      .where(and(eq(jobs.id, this.jobId), inArray(jobs.status, ['running', 'cancelling'])))
  }
  async getRun(runId: string) {
    if (this.benchmarkRunId) {
      const [run] = await this.db
        .select({ value: benchmarkRuns.run })
        .from(benchmarkRuns)
        .where(and(eq(benchmarkRuns.id, this.benchmarkRunId), eq(benchmarkRuns.jobId, this.jobId)))
      return run?.value?.runId === runId ? run.value : null
    }
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, this.jobId))
    return job?.run?.runId === runId ? job.run : null
  }
  async appendEvent(event: RunEvent) {
    const safe = this.safe(event)
    if (safe.jobId && safe.jobId !== this.jobId) {
      throw new Error('Event jobId does not match repository job')
    }
    const bytes = Buffer.byteLength(JSON.stringify(safe))
    // 不把被截断的数据冒充完整 Trace；界面必须展示此标记。
    if (bytes > 128_000) {
      safe.data = { truncated: true, originalBytes: bytes, reason: '单个事件超过 128 KB 展示上限' }
    }
    const benchmarkRunId = this.resolveBenchmarkRunId(safe.benchmarkRunId, safe.runId)
    await this.assertBenchmarkRun(benchmarkRunId)
    const persisted = {
      ...safe,
      jobId: safe.jobId ?? this.jobId,
      benchmarkRunId,
    }
    await this.db.insert(events).values({
      jobId: this.jobId,
      benchmarkRunId,
      trialId: safe.trialId,
      sequence: safe.sequence,
      event: persisted,
    })
  }
  async saveTrial(result: TrialResult) {
    const safe = this.safe(result)
    if (safe.jobId && safe.jobId !== this.jobId) {
      throw new Error('Trial jobId does not match repository job')
    }
    await this.db.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, this.jobId)).for('update')
      if (!job || !['running', 'cancelling'].includes(job.status)) {
        throw new Error('评测已结束，拒绝迟到结果')
      }
      const benchmarkRunId = this.resolveBenchmarkRunId(safe.benchmarkRunId, safe.runId)
      const [benchmarkRun] = await tx
        .select({ id: benchmarkRuns.id })
        .from(benchmarkRuns)
        .where(and(eq(benchmarkRuns.id, benchmarkRunId), eq(benchmarkRuns.jobId, this.jobId)))
      if (!benchmarkRun) {
        throw new Error('Trial benchmarkRunId does not match repository job')
      }
      const persisted = {
        ...safe,
        jobId: safe.jobId ?? this.jobId,
        benchmarkRunId,
      }
      const inserted = await tx
        .insert(trials)
        .values({
          jobId: this.jobId,
          benchmarkRunId,
          trialId: safe.trialId,
          result: persisted,
        })
        .onConflictDoNothing()
        .returning()
      if (inserted.length > 0) {
        await tx
          .update(jobs)
          .set({ completed: sql`${jobs.completed} + 1` })
          .where(eq(jobs.id, this.jobId))
      }
    })
  }
  async getTrial(trialId: string, benchmarkRunId?: string) {
    const [item] = await this.db
      .select()
      .from(trials)
      .where(
        and(
          eq(trials.jobId, this.jobId),
          eq(trials.trialId, trialId),
          benchmarkRunId ? eq(trials.benchmarkRunId, benchmarkRunId) : undefined,
        ),
      )
    return item?.result ?? null
  }
  async listTrials(runId: string) {
    const items = await this.db.select().from(trials).where(eq(trials.jobId, this.jobId))
    return items.map((item) => item.result).filter((item) => item.runId === runId)
  }
  async getEvents(trialId: string, benchmarkRunId?: string) {
    const items = await this.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.jobId, this.jobId),
          eq(events.trialId, trialId),
          benchmarkRunId ? eq(events.benchmarkRunId, benchmarkRunId) : undefined,
        ),
      )
      .orderBy(asc(events.sequence))
    return items.map((item) => item.event)
  }
  private safe<T>(value: T): T {
    const result = this.security.redactor.redactValue(value) as T
    this.security.guard.assertSafe(result, 'eval-platform')
    return result
  }
  private async assertBenchmarkRun(benchmarkRunId: string) {
    const [run] = await this.db
      .select({ id: benchmarkRuns.id })
      .from(benchmarkRuns)
      .where(and(eq(benchmarkRuns.id, benchmarkRunId), eq(benchmarkRuns.jobId, this.jobId)))
    if (!run) {
      throw new Error('Event benchmarkRunId does not match repository job')
    }
  }
  private resolveBenchmarkRunId(embeddedBenchmarkRunId: string | undefined, runId: string) {
    if (
      this.benchmarkRunId &&
      embeddedBenchmarkRunId &&
      embeddedBenchmarkRunId !== this.benchmarkRunId
    ) {
      throw new Error('BenchmarkRunId does not match repository route')
    }
    return this.benchmarkRunId ?? embeddedBenchmarkRunId ?? runId
  }
}
