import { contentDigest } from '@codeden/core/content-digest.js'
import { createSecurityServices } from '@codeden/core/security/security-services.js'
import { EvalRunner, type EvalRunSummary } from '@codeden/eval-engine/application/eval-runner.js'
import { createCodeDenAgent } from '@codeden/agent-runtime/create-codeden-runtime.js'
import type { RunCommandOptions } from '@codeden/agent-runtime/tools/builtins/run-command.js'
import { BackgroundTaskManager } from '@codeden/agent-runtime/tools/background-task-manager.js'
import type { JobSummary } from './contracts.js'
import type { JobStore } from './job-store.js'
import type { BenchmarkRunSnapshot, StoredJob } from './schema.js'
import { PlatformEvalRepository } from './eval-repository.js'
import { deriveStatistics } from './statistics.js'
import { plannedCaseSnapshotId } from './trial-plan.js'
import { datasetIdForBenchmark, harnessTypeForBenchmark } from './dataset-registry.js'
import { createHarnessRegistry, type HarnessRegistry, type HarnessType } from './harness.js'

function evalSandboxMode(): RunCommandOptions['mode'] {
  const mode = process.env.CODEDEN_EVAL_SANDBOX_MODE ?? 'docker'
  if (mode !== 'docker' && mode !== 'host') {
    throw new Error('CODEDEN_EVAL_SANDBOX_MODE 必须是 docker 或 host')
  }
  return mode
}

/** 执行一个 Job；Job 内的 BenchmarkRun 按独立并发度运行。 */
export async function executeJob(
  job: StoredJob,
  store: JobStore,
  catalog: import('./catalog.js').EvalCatalog,
  signal: AbortSignal,
  harnesses: HarnessRegistry = createHarnessRegistry(),
): Promise<JobSummary> {
  const fresh = await catalog.snapshot(job.input)
  const storedSnapshot = normalizeSnapshotForExecution(job.snapshot)
  const comparableFresh =
    job.snapshot.datasetId === undefined ? { ...fresh, datasetId: storedSnapshot.datasetId } : fresh
  // evidence 是创建时刻的环境证明（含 src/dist 上下文相关的摘要），
  // Worker 上下文无法复现它；执行依赖的是 cases/harness/模型配置，故不参与漂移检查。
  // 对比实验允许更换被测模型（modelConfigDigest 是被测变量）；数据集漂移仍会被拒绝。
  const storedForCompare: Record<string, unknown> = {
    ...storedSnapshot,
    evidence: undefined,
    modelConfigDigest: undefined,
  }
  const freshForCompare: Record<string, unknown> = {
    ...comparableFresh,
    evidence: undefined,
    modelConfigDigest: undefined,
  }
  if (contentDigest(freshForCompare) !== contentDigest(storedForCompare)) {
    const changedFields = snapshotChangedFields(storedForCompare, freshForCompare)
    throw new Error(`VERSION_CHANGED:${changedFields.join(',') || 'unknown'}`)
  }

  const runs = await store.benchmarkRunRecords(job.id)
  if (runs.length === 0) {
    throw new Error('BENCHMARK_RUN_MISSING:评测集执行实例不存在。')
  }
  const concurrency = Number(process.env.CODEDEN_EVAL_BENCHMARK_CONCURRENCY ?? '2')
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('CODEDEN_EVAL_BENCHMARK_CONCURRENCY 必须是 1 到 8 之间的整数')
  }
  const summaries = await runWithConcurrency(
    runs,
    concurrency,
    (run) => executeBenchmarkRun(job, run.id, run.snapshot, store, catalog, signal, harnesses),
    signal,
  )
  // M2 口径：任务级 P/F/U/M 以冻结计划行为唯一事实来源。
  return aggregateSummaries(job.id, summaries, await store.planCounts(job.id))
}

async function executeBenchmarkRun(
  job: StoredJob,
  benchmarkRunId: string,
  runSnapshot: BenchmarkRunSnapshot,
  store: JobStore,
  catalog: import('./catalog.js').EvalCatalog,
  signal: AbortSignal,
  harnesses: HarnessRegistry,
): Promise<EvalRunSummary> {
  const scopedJob: StoredJob = {
    ...job,
    snapshot: {
      ...job.snapshot,
      ...runSnapshot,
      modelName: job.snapshot.modelName,
      modelConfigDigest: job.snapshot.modelConfigDigest,
    },
  }
  const security = createSecurityServices()
  const repository = new PlatformEvalRepository(store.db, job.id, security, benchmarkRunId)
  const trialConcurrency = Number(process.env.CODEDEN_EVAL_TRIAL_CONCURRENCY ?? '1')
  if (!Number.isInteger(trialConcurrency) || trialConcurrency < 1 || trialConcurrency > 32) {
    throw new Error('CODEDEN_EVAL_TRIAL_CONCURRENCY 必须是 1 到 32 之间的整数')
  }

  const fallbackHarness = harnessTypeForBenchmark(scopedJob.snapshot.benchmarkName)
  const harnessType = (scopedJob.snapshot.harnessType ?? fallbackHarness) as HarnessType
  const harness = harnesses.get(harnessType)
  let preparedHarness: Awaited<ReturnType<typeof harness.prepare>> | undefined
  try {
    preparedHarness = await harness.prepare({
      job: scopedJob,
      evalRoot: process.env.CODEDEN_EVAL_ROOT ?? process.cwd(),
      sandboxMode: evalSandboxMode(),
      signal,
    })
    const { benchmark } = preparedHarness
    const runner = new EvalRunner({
      agent: {
        name: scopedJob.snapshot.modelName,
        async run(task, context) {
          signal.throwIfAborted()
          const model = await catalog.model(job.input.modelId, context.submissionType === 'text')
          const commandOptions = preparedHarness!.commandOptionsForTask(task.taskSpec.id)
          const backgroundTasks = new BackgroundTaskManager()
          const agent = createCodeDenAgent(
            model.provider,
            undefined,
            model.security,
            undefined,
            undefined,
            undefined,
            commandOptions,
            undefined,
            undefined,
            backgroundTasks,
          )
          return agent
            .run(task, {
              ...context,
              abortSignal: context.abortSignal
                ? AbortSignal.any([signal, context.abortSignal])
                : signal,
              eventSink: {
                async emit(source, type, data) {
                  const safe = model.security.redactor.redactValue(data)
                  model.security.guard.assertSafe(safe, 'eval-platform-model')
                  await context.eventSink.emit(source, type, safe)
                },
              },
            })
            .then((result) => model.security.redactor.redactValue(result) as typeof result)
            .finally(() => backgroundTasks.killAll('trial-finished'))
        },
      },
      benchmark: {
        name: benchmark.name,
        load: (source) => benchmark.load(source),
        async prepare(evalCase, workspace) {
          signal.throwIfAborted()
          return benchmark.prepare(evalCase, workspace)
        },
        async verify(prepared, submission, context) {
          signal.throwIfAborted()
          return benchmark.verify(prepared, submission, context)
        },
      },
      workspaceFactory: preparedHarness.workspaceFactory,
      repository,
      security,
      evidence: scopedJob.snapshot.evidence,
      trialConcurrency,
      runId: benchmarkRunId,
      jobId: job.id,
      benchmarkRunId,
    })
    const summary = await runner.run(scopedJob.snapshot.cases, signal)
    signal.throwIfAborted()
    // M3 重试边界：仅对确认未调用 Agent 的准备故障重试 1 次（新环境、新 trialId，原故障保留在账本）。
    const retryable = await store.retryablePrepareFailures(job.id, benchmarkRunId)
    if (retryable.length > 0) {
      await store.resetPlansForRetry(job.id, benchmarkRunId, retryable)
      const retryIds = new Set(
        retryable.map((plan) => plannedCaseSnapshotId(plan.caseId, plan.repetitionIndex)),
      )
      const retryCases = scopedJob.snapshot.cases.filter((item) => retryIds.has(item.id))
      if (retryCases.length > 0) {
        const retryRunner = new EvalRunner({
          agent: {
            name: scopedJob.snapshot.modelName,
            async run(task, context) {
              signal.throwIfAborted()
              const model = await catalog.model(
                job.input.modelId,
                context.submissionType === 'text',
              )
              const commandOptions = preparedHarness!.commandOptionsForTask(task.taskSpec.id)
              const agent = createCodeDenAgent(
                model.provider,
                undefined,
                model.security,
                undefined,
                undefined,
                undefined,
                commandOptions,
              )
              return agent
                .run(task, {
                  ...context,
                  abortSignal: context.abortSignal
                    ? AbortSignal.any([signal, context.abortSignal])
                    : signal,
                  eventSink: {
                    async emit(source, type, data) {
                      const safe = model.security.redactor.redactValue(data)
                      model.security.guard.assertSafe(safe, 'eval-platform-model')
                      await context.eventSink.emit(source, type, safe)
                    },
                  },
                })
                .then((result) => model.security.redactor.redactValue(result) as typeof result)
            },
          },
          benchmark: {
            name: benchmark.name,
            load: (source) => benchmark.load(source),
            async prepare(evalCase, workspace) {
              signal.throwIfAborted()
              return benchmark.prepare(evalCase, workspace)
            },
            async verify(prepared, submission, context) {
              signal.throwIfAborted()
              return benchmark.verify(prepared, submission, context)
            },
          },
          workspaceFactory: preparedHarness.workspaceFactory,
          repository,
          security,
          evidence: scopedJob.snapshot.evidence,
          trialConcurrency,
          runId: benchmarkRunId,
          jobId: job.id,
          benchmarkRunId,
        })
        await retryRunner.run(retryCases, signal)
        signal.throwIfAborted()
      }
    }
    const { trials: _trials, ...result } = summary
    // M2 口径：run 级 P/F/U/M 同样以计划行为准。
    const runCounts = await store.planCounts(job.id, benchmarkRunId)
    const runStatistics = deriveStatistics(runCounts)
    await store.finishBenchmarkRun(benchmarkRunId, 'completed', {
      ...result,
      totalCases: runStatistics.planned,
      passedCases: runCounts.pass,
      failedCases: runCounts.fail,
      passRate: runStatistics.passShare ?? 0,
      allResolved: runStatistics.planned > 0 && !runStatistics.incomplete && runCounts.fail === 0,
    })
    return summary
  } catch (error) {
    await store.finishBenchmarkRun(benchmarkRunId, signal.aborted ? 'cancelled' : 'failed')
    throw error
  } finally {
    await preparedHarness?.dispose()
  }
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
  signal: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (true) {
      signal.throwIfAborted()
      const index = next++
      if (index >= items.length) {
        return
      }
      results[index] = await run(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

function aggregateSummaries(
  jobId: string,
  summaries: EvalRunSummary[],
  counts: { pass: number; fail: number; unknown: number; pending: number },
): JobSummary {
  const statistics = deriveStatistics(counts)
  const totalCases = statistics.planned
  const passedCases = counts.pass
  const infrastructureErrors = summaries.reduce((sum, item) => sum + item.infrastructureErrors, 0)
  const modelRequests = summaries.reduce((sum, item) => sum + item.modelRequests, 0)
  const measuredTokenRequests = summaries.reduce((sum, item) => sum + item.measuredTokenRequests, 0)
  return {
    runId: jobId,
    totalCases,
    passedCases,
    // M2 口径：不通过 = 计划行 fail，不再用 total-passed 把未判定/未完成冒充失败。
    failedCases: counts.fail,
    unknownCases: counts.unknown,
    pendingCases: counts.pending,
    statisticsVersion: statistics.statisticsVersion,
    passShare: statistics.passShare,
    validSuccessRate: statistics.validSuccessRate,
    coverage: statistics.coverage,
    incomplete: statistics.incomplete,
    infrastructureErrors,
    passRate: statistics.passShare ?? 0,
    durationMs: Math.max(...summaries.map((item) => item.durationMs), 0),
    toolCalls: summaries.reduce((sum, item) => sum + item.toolCalls, 0),
    inputTokens: summaries.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: summaries.reduce((sum, item) => sum + item.outputTokens, 0),
    modelRequests,
    measuredTokenRequests,
    tokenUsageCoverage: modelRequests === 0 ? 0 : measuredTokenRequests / modelRequests,
    p95LatencyMs: Math.max(...summaries.map((item) => item.p95LatencyMs), 0),
    failureClusters: summaries.flatMap((item) => item.failureClusters),
    allResolved: totalCases > 0 && !statistics.incomplete && counts.fail === 0,
    infrastructureFailed:
      infrastructureErrors > 0 &&
      passedCases === 0 &&
      summaries.every((item) => item.infrastructureFailed),
  }
}

export function normalizeSnapshotForExecution(
  snapshot: StoredJob['snapshot'],
): StoredJob['snapshot'] {
  return {
    ...snapshot,
    datasetId: snapshot.datasetId ?? datasetIdForBenchmark(snapshot.benchmarkName),
    harnessType: snapshot.harnessType ?? harnessTypeForBenchmark(snapshot.benchmarkName),
  }
}

function snapshotChangedFields(stored: Record<string, unknown>, fresh: Record<string, unknown>) {
  return [...new Set([...Object.keys(stored), ...Object.keys(fresh)])]
    .sort()
    .filter(
      (key) =>
        contentDigest((stored as unknown as Record<string, unknown>)[key]) !==
        contentDigest((fresh as unknown as Record<string, unknown>)[key]),
    )
}
