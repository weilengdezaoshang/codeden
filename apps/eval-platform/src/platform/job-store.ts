import { randomUUID } from 'node:crypto'
import { contentDigest } from '@codeden/core/content-digest.js'
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { fromDrizzle, type PgBoss } from 'pg-boss'
import type { Database } from './database.js'
import {
  benchmarkRuns,
  evalExecutionAttempts,
  evalTrialPlans,
  jobs,
  trials,
  events,
  type BenchmarkRunSnapshot,
  type JobSnapshot,
  type StoredJob,
} from './schema.js'
import {
  ACTIVE_STATUSES,
  PlatformError,
  type CreateJobInput,
  type JobView,
  type JobSummary,
} from './contracts.js'
import { buildTrialPlans, parsePlannedCaseId, STATISTICS_VERSION } from './trial-plan.js'
import { deriveCaseStatistics, deriveStatistics } from './statistics.js'
import { compareExperimentSides, type ComparisonSide } from './comparison.js'

export const QUEUE_NAME = 'codeden-evaluations'
export class JobStore {
  constructor(readonly db: Database) {}

  async create(input: CreateJobInput, snapshot: JobSnapshot, boss: Pick<PgBoss, 'send'>) {
    return this.db.transaction(async (tx) => {
      // 序列化创建，使排队上限与幂等检查在多请求下同样成立。
      await tx.execute(sql`SELECT pg_advisory_xact_lock(70130902)`)
      const [existing] = await tx.select().from(jobs).where(eq(jobs.requestId, input.requestId))
      if (existing) {
        if (contentDigest(existing.input) !== contentDigest(input)) {
          throw new PlatformError(409, 'REQUEST_REUSED', '这个请求编号已用于其他评测，请重新提交。')
        }
        return existing
      }
      const active = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.status, ACTIVE_STATUSES))
        .limit(20)
      if (active.length >= 20) {
        throw new PlatformError(429, 'QUEUE_FULL', '等待中的任务过多，请稍后再试。')
      }
      const jobId = randomUUID()
      const runSnapshots = snapshot.benchmarkRuns ?? [toBenchmarkRunSnapshot(snapshot)]
      const [job] = await tx
        .insert(jobs)
        .values({
          id: jobId,
          requestId: input.requestId,
          input,
          snapshot,
          status: 'queued',
          total: runSnapshots.reduce((sum, item) => sum + item.cases.length, 0),
        })
        .returning()
      const runRows = runSnapshots.map((runSnapshot) => ({
        id: randomUUID(),
        jobId,
        benchmarkType: runSnapshot.benchmarkName,
        harnessType: runSnapshot.harnessType,
        status: 'queued' as const,
        total: runSnapshot.cases.length,
        snapshot: runSnapshot,
      }))
      await tx.insert(benchmarkRuns).values(runRows)
      // 冻结全部 Trial 计划：创建即落行，失败/取消不增删计划（N = P+F+U+M 守恒的根基）。
      const plans = runSnapshots.flatMap((runSnapshot, index) =>
        buildTrialPlans(runSnapshot.cases.map((item) => item.id)).map((plan) => ({
          jobId,
          benchmarkRunId: runRows[index]!.id,
          ...plan,
          statisticsVersion: STATISTICS_VERSION,
        })),
      )
      if (plans.length !== job!.total) {
        throw new Error('Trial 计划与评测集快照不一致')
      }
      await tx.insert(evalTrialPlans).values(plans)
      const queueId = await boss.send(
        QUEUE_NAME,
        { jobId: job!.id },
        {
          id: job!.id,
          retryLimit: 0,
          expireInSeconds: 900,
          db: fromDrizzle(tx, sql),
        },
      )
      if (!queueId) {
        throw new Error('Queue insertion failed')
      }
      return job!
    })
  }

  async get(id: string) {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, id))
    if (!job) {
      throw new PlatformError(404, 'JOB_NOT_FOUND', '评测任务不存在。')
    }
    return job
  }
  async list(offset: number, limit: number): Promise<JobView[]> {
    const rows = await this.db
      .select()
      .from(jobs)
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .offset(offset)
      .limit(limit)
    return rows.map(toJobView)
  }
  async detail(id: string) {
    const job = await this.get(id)
    const evidence = job.snapshot.evidence
    return {
      ...toJobView(job),
      cases: job.snapshot.cases.map((item) => ({
        id: item.id,
        goal: item.task.taskSpec.goal,
        prompt: item.task.prompt,
        acceptanceCriteria: item.task.taskSpec.acceptanceCriteria,
        submissionType: item.submission.type,
      })),
      trials: await this.listTrials(id),
      benchmarkRuns: await this.listBenchmarkRuns(id),
      progress: await this.progress(id),
      progresses: await this.progresses(id),
      trialProgresses: await this.trialProgresses(id),
      statistics: await this.jobStatistics(id),
      versions: {
        dataset: evidence?.datasetDigest ?? job.snapshot.benchmarkSha256 ?? 'unavailable',
        agent: evidence?.agentDigest ?? job.snapshot.modelConfigDigest,
        grader: evidence?.graderDigest ?? job.snapshot.benchmarkName,
        environment: evidence?.environmentDigest ?? job.snapshot.benchmarkVersion ?? 'unavailable',
      },
    }
  }
  async listBenchmarkRuns(jobId: string) {
    await this.get(jobId)
    const rows = await this.db
      .select()
      .from(benchmarkRuns)
      .where(eq(benchmarkRuns.jobId, jobId))
      .orderBy(asc(benchmarkRuns.createdAt), asc(benchmarkRuns.id))
    return rows.map(toBenchmarkRunView)
  }
  async benchmarkRunRecords(jobId: string) {
    await this.get(jobId)
    return this.db
      .select()
      .from(benchmarkRuns)
      .where(eq(benchmarkRuns.jobId, jobId))
      .orderBy(asc(benchmarkRuns.createdAt), asc(benchmarkRuns.id))
  }
  async finishBenchmarkRun(
    benchmarkRunId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    summary?: JobSummary,
  ) {
    await this.db
      .update(benchmarkRuns)
      .set({
        status,
        finishedAt: sql`now()`,
        ...(summary ? { summary, completed: summary.totalCases } : {}),
      })
      .where(
        and(
          eq(benchmarkRuns.id, benchmarkRunId),
          inArray(benchmarkRuns.status, ['queued', 'running']),
        ),
      )
  }
  async primaryBenchmarkRun(jobId: string) {
    await this.get(jobId)
    const [run] = await this.db
      .select()
      .from(benchmarkRuns)
      .where(eq(benchmarkRuns.jobId, jobId))
      .orderBy(asc(benchmarkRuns.createdAt), asc(benchmarkRuns.id))
      .limit(1)
    if (!run) {
      throw new PlatformError(500, 'BENCHMARK_RUN_MISSING', '评测集执行实例不存在。')
    }
    return run
  }
  async progress(id: string) {
    const [latest] = await this.db
      .select({ trialId: events.trialId, benchmarkRunId: events.benchmarkRunId })
      .from(events)
      .where(eq(events.jobId, id))
      .orderBy(desc(sql`(${events.event}->>'timestamp')`), desc(events.sequence))
      .limit(1)
    if (!latest) {
      return null
    }
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.jobId, id),
          eq(events.trialId, latest.trialId),
          eq(events.benchmarkRunId, latest.benchmarkRunId),
        ),
      )
      .orderBy(desc(events.sequence))
      .limit(100)
    const items = rows.reverse().map((item) => item.event)
    const started = items.find((item) => item.type === 'eval.trial.started')
    const data = started?.data
    const caseId =
      data && typeof data === 'object' && 'caseId' in data && typeof data.caseId === 'string'
        ? data.caseId
        : latest.trialId
    return {
      trialId: latest.trialId,
      caseId,
      benchmarkRunId: latest.benchmarkRunId,
      events: items,
    }
  }
  async progresses(id: string) {
    await this.get(id)
    const runs = await this.db
      .select({ benchmarkRunId: benchmarkRuns.id })
      .from(benchmarkRuns)
      .where(eq(benchmarkRuns.jobId, id))
      .orderBy(asc(benchmarkRuns.createdAt), asc(benchmarkRuns.id))
    const values = await Promise.all(runs.map((run) => this.progressForRun(id, run.benchmarkRunId)))
    return values.filter((item): item is NonNullable<typeof item> => item !== null)
  }
  async trialProgresses(id: string) {
    await this.get(id)
    const rows = await this.db
      .select({ trialId: events.trialId, benchmarkRunId: events.benchmarkRunId })
      .from(events)
      .where(eq(events.jobId, id))
      .orderBy(asc(events.benchmarkRunId), asc(events.trialId))
    const keys = [...new Set(rows.map((item) => `${item.benchmarkRunId}\u0000${item.trialId}`))]
    const values = await Promise.all(
      keys.map((key) => {
        const separator = key.indexOf('\u0000')
        return this.progressForTrial(id, key.slice(separator + 1), key.slice(0, separator))
      }),
    )
    return values.filter((item): item is NonNullable<typeof item> => item !== null)
  }
  private async progressForRun(jobId: string, benchmarkRunId: string) {
    const [latest] = await this.db
      .select({ trialId: events.trialId })
      .from(events)
      .where(and(eq(events.jobId, jobId), eq(events.benchmarkRunId, benchmarkRunId)))
      .orderBy(desc(sql`(${events.event}->>'timestamp')`), desc(events.sequence))
      .limit(1)
    if (!latest) {
      return null
    }
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.jobId, jobId),
          eq(events.benchmarkRunId, benchmarkRunId),
          eq(events.trialId, latest.trialId),
        ),
      )
      .orderBy(desc(events.sequence))
      .limit(100)
    const items = rows.reverse().map((item) => item.event)
    const started = items.find((item) => item.type === 'eval.trial.started')
    const data = started?.data
    const caseId =
      data && typeof data === 'object' && 'caseId' in data && typeof data.caseId === 'string'
        ? data.caseId
        : latest.trialId
    return { trialId: latest.trialId, caseId, benchmarkRunId, events: items }
  }
  private async progressForTrial(jobId: string, trialId: string, benchmarkRunId: string) {
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.jobId, jobId),
          eq(events.benchmarkRunId, benchmarkRunId),
          eq(events.trialId, trialId),
        ),
      )
      .orderBy(desc(events.sequence))
      .limit(100)
    if (rows.length === 0) {
      return null
    }
    const items = rows.reverse().map((item) => item.event)
    const started = items.find((item) => item.type === 'eval.trial.started')
    const data = started?.data
    const caseId =
      data && typeof data === 'object' && 'caseId' in data && typeof data.caseId === 'string'
        ? data.caseId
        : trialId
    return { trialId, caseId, benchmarkRunId, events: items }
  }
  async listTrials(id: string) {
    const rows = await this.db
      .select()
      .from(trials)
      .where(eq(trials.jobId, id))
      .orderBy(asc(trials.trialId))
    return rows.map((item) => item.result)
  }
  async eventPage(
    id: string,
    trialId: string,
    offset: number,
    limit: number,
    benchmarkRunId?: string,
    afterSequence?: number,
  ) {
    await this.get(id)
    if (!benchmarkRunId) {
      const runCount = await this.db
        .select({ id: benchmarkRuns.id })
        .from(benchmarkRuns)
        .where(eq(benchmarkRuns.jobId, id))
      if (runCount.length > 1) {
        throw new PlatformError(
          400,
          'BENCHMARK_RUN_REQUIRED',
          '该 Job 包含多个评测集，请提供 benchmarkRunId 后查询事件。',
        )
      }
    }
    const route = benchmarkRunId ? eq(events.benchmarkRunId, benchmarkRunId) : undefined
    const cursor = afterSequence === undefined ? undefined : gt(events.sequence, afterSequence)
    const items = await this.db
      .select()
      .from(events)
      .where(and(eq(events.jobId, id), eq(events.trialId, trialId), route, cursor))
      .orderBy(asc(events.sequence))
      .offset(afterSequence === undefined ? offset : 0)
      .limit(limit + 1)
    const pageItems = items.slice(0, limit).map((item) => item.event)
    return {
      items: pageItems,
      nextOffset: afterSequence === undefined && items.length > limit ? offset + limit : null,
      lastSequence: pageItems.at(-1)?.sequence ?? afterSequence ?? null,
      nextSequence: items.length > limit ? (pageItems.at(-1)?.sequence ?? null) : null,
    }
  }
  async cancel(id: string) {
    await this.db.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update')
      if (!job) {
        throw new PlatformError(404, 'JOB_NOT_FOUND', '评测任务不存在。')
      }
      if (!ACTIVE_STATUSES.includes(job.status)) {
        return
      }
      await tx
        .update(jobs)
        .set(
          job.status === 'queued'
            ? { status: 'cancelled', finishedAt: sql`now()`, message: '任务已取消，未开始执行。' }
            : { status: 'cancelling', message: '正在停止当前评测…' },
        )
        .where(eq(jobs.id, id))
      if (job.status === 'queued') {
        await tx
          .update(benchmarkRuns)
          .set({ status: 'cancelled', finishedAt: sql`now()` })
          .where(and(eq(benchmarkRuns.jobId, id), eq(benchmarkRuns.status, 'queued')))
        // 排队即取消：全部未完成计划行进入 cancelled（计 M，verdict 保持 NULL）。
        await tx
          .update(evalTrialPlans)
          .set({ lifecycle: 'cancelled', updatedAt: sql`now()` })
          .where(and(eq(evalTrialPlans.jobId, id), sql`${evalTrialPlans.lifecycle} <> 'completed'`))
      }
    })
    return toJobView(await this.get(id))
  }
  async delete(id: string) {
    await this.db.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update')
      if (!job) {
        throw new PlatformError(404, 'JOB_NOT_FOUND', '评测任务不存在。')
      }
      if (ACTIVE_STATUSES.includes(job.status)) {
        throw new PlatformError(409, 'JOB_ACTIVE', '评测执行中，无法删除。请先取消任务。')
      }
      await tx.delete(events).where(eq(events.jobId, id))
      await tx.delete(trials).where(eq(trials.jobId, id))
      await tx.delete(benchmarkRuns).where(eq(benchmarkRuns.jobId, id))
      await tx.delete(jobs).where(eq(jobs.id, id))
    })
  }
  async claim(id: string) {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .update(jobs)
        .set({ status: 'running', heartbeatAt: sql`now()` })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'queued')))
        .returning()
      if (!job) {
        return undefined
      }
      await tx
        .update(benchmarkRuns)
        .set({ status: 'running', startedAt: sql`now()` })
        .where(and(eq(benchmarkRuns.jobId, id), eq(benchmarkRuns.status, 'queued')))
      return job
    })
  }
  async heartbeat(id: string) {
    const [job] = await this.db
      .update(jobs)
      .set({ heartbeatAt: sql`now()` })
      .where(and(eq(jobs.id, id), inArray(jobs.status, ['running', 'cancelling'])))
      .returning({ status: jobs.status })
    return job?.status
  }
  async finish(
    id: string,
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    message: string | null,
    summary?: JobSummary,
  ) {
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(jobs)
        .set({
          status: sql`CASE WHEN ${jobs.status} = 'cancelling' THEN 'cancelled' ELSE ${status} END`,
          message,
          ...(summary ? { summary } : {}),
          finishedAt: sql`now()`,
        })
        .where(and(eq(jobs.id, id), inArray(jobs.status, ['running', 'cancelling'])))
        .returning({ status: jobs.status })
      if (!updated) {
        return
      }
      const finalStatus = updated.status === 'cancelled' ? 'cancelled' : status
      await tx
        .update(benchmarkRuns)
        .set({
          status: finalStatus,
          finishedAt: sql`now()`,
          ...(summary ? { summary, completed: summary.totalCases } : {}),
        })
        .where(
          and(eq(benchmarkRuns.jobId, id), inArray(benchmarkRuns.status, ['queued', 'running'])),
        )
      // 终态扫尾：未完成计划行按任务终态归类；取消/中断计 M，verdict 保持 NULL。
      const terminalLifecycle =
        finalStatus === 'cancelled'
          ? 'cancelled'
          : finalStatus === 'interrupted'
            ? 'interrupted'
            : null
      if (terminalLifecycle) {
        await tx
          .update(evalTrialPlans)
          .set({ lifecycle: terminalLifecycle, updatedAt: sql`now()` })
          .where(and(eq(evalTrialPlans.jobId, id), sql`${evalTrialPlans.lifecycle} <> 'completed'`))
      }
    })
  }
  async recoverInterrupted(staleBefore: string) {
    return this.db.transaction(async (tx) => {
      const interrupted = await tx
        .update(jobs)
        .set({
          status: 'interrupted',
          finishedAt: sql`now()`,
          message: '执行进程已中断。已有结果保留；请手动新建评测，不会自动重复付费调用。',
        })
        .where(
          and(inArray(jobs.status, ['running', 'cancelling']), lt(jobs.heartbeatAt, staleBefore)),
        )
        .returning({ id: jobs.id })
      for (const job of interrupted) {
        await tx
          .update(benchmarkRuns)
          .set({ status: 'interrupted', finishedAt: sql`now()` })
          .where(
            and(
              eq(benchmarkRuns.jobId, job.id),
              inArray(benchmarkRuns.status, ['queued', 'running']),
            ),
          )
        await tx
          .update(evalTrialPlans)
          .set({ lifecycle: 'interrupted', updatedAt: sql`now()` })
          .where(
            and(
              eq(evalTrialPlans.jobId, job.id),
              inArray(evalTrialPlans.lifecycle, ['queued', 'preparing', 'running', 'grading']),
            ),
          )
      }
      return interrupted
    })
  }

  /** 计划口径统计：P/F/U/M 恒等守恒（N = P+F+U+M），M = 未完成（verdict NULL 的计划行）。 */
  async planCounts(
    jobId: string,
    benchmarkRunId?: string,
  ): Promise<{
    planned: number
    pass: number
    fail: number
    unknown: number
    pending: number
  }> {
    const rows = await this.db
      .select({
        lifecycle: evalTrialPlans.lifecycle,
        verdict: evalTrialPlans.verdict,
      })
      .from(evalTrialPlans)
      .where(
        and(
          eq(evalTrialPlans.jobId, jobId),
          benchmarkRunId ? eq(evalTrialPlans.benchmarkRunId, benchmarkRunId) : undefined,
        ),
      )
    const counts = { planned: rows.length, pass: 0, fail: 0, unknown: 0, pending: 0 }
    for (const row of rows) {
      if (
        row.lifecycle === 'completed' &&
        (row.verdict === 'pass' || row.verdict === 'fail' || row.verdict === 'unknown')
      ) {
        counts[row.verdict] += 1
      } else {
        counts.pending += 1
      }
    }
    return counts
  }

  /** 按题聚合计划行计数，供每题 Wilson 区间与分类标签使用。 */
  async caseCounts(
    jobId: string,
    benchmarkRunId?: string,
  ): Promise<
    Map<
      string,
      { pass: number; fail: number; unknown: number; pending: number; repetitionCount: number }
    >
  > {
    const rows = await this.db
      .select({
        caseId: evalTrialPlans.caseId,
        lifecycle: evalTrialPlans.lifecycle,
        verdict: evalTrialPlans.verdict,
      })
      .from(evalTrialPlans)
      .where(
        and(
          eq(evalTrialPlans.jobId, jobId),
          benchmarkRunId ? eq(evalTrialPlans.benchmarkRunId, benchmarkRunId) : undefined,
        ),
      )
      .orderBy(asc(evalTrialPlans.position))
    const byCase = new Map<
      string,
      { pass: number; fail: number; unknown: number; pending: number; repetitionCount: number }
    >()
    for (const row of rows) {
      const entry = byCase.get(row.caseId) ?? {
        pass: 0,
        fail: 0,
        unknown: 0,
        pending: 0,
        repetitionCount: 0,
      }
      entry.repetitionCount += 1
      if (
        row.lifecycle === 'completed' &&
        (row.verdict === 'pass' || row.verdict === 'fail' || row.verdict === 'unknown')
      ) {
        entry[row.verdict] += 1
      } else {
        entry.pending += 1
      }
      byCase.set(row.caseId, entry)
    }
    return byCase
  }

  /** 详情响应的统计块：任务级三比率 + 每题 Wilson + 执行尝试成本账本。 */
  async jobStatistics(jobId: string) {
    await this.get(jobId)
    const counts = await this.planCounts(jobId)
    const statistics = deriveStatistics(counts)
    const byCase = await this.caseCounts(jobId)
    const cases = [...byCase.entries()].map(([caseId, entry]) =>
      deriveCaseStatistics(caseId, entry),
    )
    cases.sort((left, right) => left.caseId.localeCompare(right.caseId))
    const attemptRows = await this.db
      .select({
        attemptIndex: evalExecutionAttempts.attemptIndex,
        outcome: evalExecutionAttempts.outcome,
        inputTokens: evalExecutionAttempts.inputTokens,
        outputTokens: evalExecutionAttempts.outputTokens,
        durationMs: evalExecutionAttempts.durationMs,
      })
      .from(evalExecutionAttempts)
      .where(eq(evalExecutionAttempts.jobId, jobId))
    const attempts = {
      total: attemptRows.length,
      retried: attemptRows.filter((row) => row.attemptIndex > 1).length,
      // 只累计实测用量；未测得的 NULL 不冒充 0。
      inputTokens: attemptRows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: attemptRows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      durationMs: attemptRows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0),
    }
    return { ...statistics, cases, attempts }
  }

  /** 定位视图：按归因/失败阶段筛选执行尝试账本。 */
  async filteredAttempts(
    jobId: string,
    filters: { errorCategory?: string; failureStage?: string; retriedOnly?: boolean },
  ) {
    await this.get(jobId)
    const rows = await this.db
      .select({
        benchmarkRunId: evalExecutionAttempts.benchmarkRunId,
        caseId: evalExecutionAttempts.caseId,
        repetitionIndex: evalExecutionAttempts.repetitionIndex,
        attemptIndex: evalExecutionAttempts.attemptIndex,
        trialId: evalExecutionAttempts.trialId,
        outcome: evalExecutionAttempts.outcome,
        errorCategory: evalExecutionAttempts.errorCategory,
        failureStage: evalExecutionAttempts.failureStage,
        failureDetail: evalExecutionAttempts.failureDetail,
        inputTokens: evalExecutionAttempts.inputTokens,
        outputTokens: evalExecutionAttempts.outputTokens,
        durationMs: evalExecutionAttempts.durationMs,
        tokensMeasured: evalExecutionAttempts.tokensMeasured,
      })
      .from(evalExecutionAttempts)
      .where(
        and(
          eq(evalExecutionAttempts.jobId, jobId),
          filters.errorCategory
            ? eq(evalExecutionAttempts.errorCategory, filters.errorCategory)
            : undefined,
          filters.failureStage
            ? eq(evalExecutionAttempts.failureStage, filters.failureStage)
            : undefined,
          filters.retriedOnly ? sql`${evalExecutionAttempts.attemptIndex} > 1` : undefined,
        ),
      )
      .orderBy(
        asc(evalExecutionAttempts.caseId),
        asc(evalExecutionAttempts.repetitionIndex),
        asc(evalExecutionAttempts.attemptIndex),
      )
    return { items: rows }
  }

  /** 同条件对比（只读）：候选 = 当前 Job，基线 = baselineJobId。 */
  async compareJobs(candidateId: string, baselineId: string) {
    const [candidate, baseline] = await Promise.all([this.get(candidateId), this.get(baselineId)])
    const side = async (job: StoredJob): Promise<ComparisonSide> => ({
      id: job.id,
      status: job.status,
      datasetId: job.input.datasetId,
      repetitions: job.input.repetitions,
      datasetDigest: job.snapshot.benchmarkSha256 ?? job.snapshot.evidence?.datasetDigest ?? null,
      harnessType: job.snapshot.harnessType,
      caseIds: job.snapshot.cases.map((item) => {
        const { baseId } = parsePlannedCaseId(item.id)
        return baseId
      }),
      statistics: await this.jobStatistics(job.id),
    })
    return compareExperimentSides(await side(baseline), await side(candidate))
  }

  /** 可重试的准备故障：归因 env_failure/prepare、账本证实未调用 Agent（model_requests=0）、且尚未重试过。 */
  async retryablePrepareFailures(jobId: string, benchmarkRunId: string) {
    return this.db
      .select({
        caseId: evalTrialPlans.caseId,
        repetitionIndex: evalTrialPlans.repetitionIndex,
      })
      .from(evalTrialPlans)
      .where(
        and(
          eq(evalTrialPlans.jobId, jobId),
          eq(evalTrialPlans.benchmarkRunId, benchmarkRunId),
          eq(evalTrialPlans.lifecycle, 'completed'),
          eq(evalTrialPlans.verdict, 'unknown'),
          eq(evalTrialPlans.errorCategory, 'env_failure'),
          eq(evalTrialPlans.failureStage, 'prepare'),
          eq(evalTrialPlans.attemptCount, 1),
          // runtime_error 可能发生在 Agent 已执行之后：重试资格必须以账本中零模型调用为准。
          sql`EXISTS (
            SELECT 1 FROM eval_execution_attempts a
            WHERE a.job_id = ${evalTrialPlans.jobId}
              AND a.benchmark_run_id = ${evalTrialPlans.benchmarkRunId}
              AND a.case_id = ${evalTrialPlans.caseId}
              AND a.repetition_index = ${evalTrialPlans.repetitionIndex}
              AND a.attempt_index = ${evalTrialPlans.attemptCount}
              AND COALESCE(a.model_requests, 0) = 0
          )`,
        ),
      )
  }

  /** 重试前重置计划行：回到 queued，保留原故障于账本；attempt_count+1 防并发重复重试。 */
  async resetPlansForRetry(
    jobId: string,
    benchmarkRunId: string,
    plans: readonly { caseId: string; repetitionIndex: number }[],
  ) {
    for (const plan of plans) {
      await this.db
        .update(evalTrialPlans)
        .set({
          lifecycle: 'queued',
          verdict: null,
          errorCategory: null,
          failureStage: null,
          failureDetail: null,
          attemptCount: sql`${evalTrialPlans.attemptCount} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(evalTrialPlans.jobId, jobId),
            eq(evalTrialPlans.benchmarkRunId, benchmarkRunId),
            eq(evalTrialPlans.caseId, plan.caseId),
            eq(evalTrialPlans.repetitionIndex, plan.repetitionIndex),
            eq(evalTrialPlans.attemptCount, 1),
          ),
        )
    }
  }
}
export function toJobView(job: StoredJob): JobView {
  const repetitions = job.input.repetitions
  return {
    id: job.id,
    datasetId: job.input.datasetId,
    datasetName: job.snapshot.datasetName,
    modelName: job.snapshot.modelName,
    synthetic: job.input.modelId === 'mock',
    caseCount: repetitions > 0 ? Math.ceil(job.total / repetitions) : job.total,
    repetitions,
    status: job.status,
    total: job.total,
    completed: job.completed,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    message: job.message,
    summary: job.summary,
  }
}

function toBenchmarkRunView(run: typeof benchmarkRuns.$inferSelect) {
  return {
    benchmarkRunId: run.id,
    jobId: run.jobId,
    benchmarkType: run.benchmarkType,
    datasetId: run.snapshot.datasetId,
    datasetName: run.snapshot.datasetName,
    harnessType: run.harnessType,
    status: run.status,
    total: run.total,
    completed: run.completed,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    summary: run.summary ?? null,
  }
}

function toBenchmarkRunSnapshot(snapshot: JobSnapshot): BenchmarkRunSnapshot {
  return {
    datasetId: snapshot.datasetId,
    datasetName: snapshot.datasetName,
    benchmarkName: snapshot.benchmarkName,
    harnessType: snapshot.harnessType,
    ...(snapshot.benchmarkVersion ? { benchmarkVersion: snapshot.benchmarkVersion } : {}),
    ...(snapshot.benchmarkLicense ? { benchmarkLicense: snapshot.benchmarkLicense } : {}),
    ...(snapshot.benchmarkSha256 ? { benchmarkSha256: snapshot.benchmarkSha256 } : {}),
    cases: snapshot.cases,
    ...(snapshot.evidence ? { evidence: snapshot.evidence } : {}),
  }
}
