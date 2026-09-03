import { contentDigest } from '@codeden/core/content-digest.js'
import { createSecurityServices } from '@codeden/core/security/security-services.js'
import { EvalRunner, type EvalRunSummary } from '@codeden/eval-engine/application/eval-runner.js'
import { createCodeDenAgent } from '@codeden/agent-runtime/create-codeden-runtime.js'
import type { RunCommandOptions } from '@codeden/agent-runtime/tools/builtins/run-command.js'
import type { JobSummary } from './contracts.js'
import type { JobStore } from './job-store.js'
import type { BenchmarkRunSnapshot, StoredJob } from './schema.js'
import { PlatformEvalRepository } from './eval-repository.js'
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
  if (contentDigest(comparableFresh) !== contentDigest(storedSnapshot)) {
    const changedFields = snapshotChangedFields(storedSnapshot, comparableFresh)
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
  return aggregateSummaries(job.id, summaries)
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

  const fallbackHarness = fallbackHarnessForBenchmark(scopedJob.snapshot.benchmarkName)
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
    const summary = await runner.run(scopedJob.snapshot.cases, signal)
    signal.throwIfAborted()
    const { trials: _trials, ...result } = summary
    await store.finishBenchmarkRun(benchmarkRunId, 'completed', result)
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

function aggregateSummaries(jobId: string, summaries: EvalRunSummary[]): JobSummary {
  const totalCases = summaries.reduce((sum, item) => sum + item.totalCases, 0)
  const passedCases = summaries.reduce((sum, item) => sum + item.passedCases, 0)
  const infrastructureErrors = summaries.reduce((sum, item) => sum + item.infrastructureErrors, 0)
  const modelRequests = summaries.reduce((sum, item) => sum + item.modelRequests, 0)
  const measuredTokenRequests = summaries.reduce((sum, item) => sum + item.measuredTokenRequests, 0)
  return {
    runId: jobId,
    totalCases,
    passedCases,
    failedCases: totalCases - passedCases,
    infrastructureErrors,
    passRate: totalCases === 0 ? 0 : passedCases / totalCases,
    durationMs: Math.max(...summaries.map((item) => item.durationMs), 0),
    toolCalls: summaries.reduce((sum, item) => sum + item.toolCalls, 0),
    inputTokens: summaries.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: summaries.reduce((sum, item) => sum + item.outputTokens, 0),
    modelRequests,
    measuredTokenRequests,
    tokenUsageCoverage: modelRequests === 0 ? 0 : measuredTokenRequests / modelRequests,
    p95LatencyMs: Math.max(...summaries.map((item) => item.p95LatencyMs), 0),
    failureClusters: summaries.flatMap((item) => item.failureClusters),
    allResolved: totalCases > 0 && summaries.every((item) => item.allResolved),
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
    datasetId:
      snapshot.datasetId ??
      (snapshot.benchmarkName === 'swebench-lite'
        ? 'swebench-lite'
        : snapshot.benchmarkName === 'swe-polybench'
          ? 'swe-polybench'
          : snapshot.benchmarkName === 'terminal-bench'
            ? 'terminal-bench'
            : 'all'),
    harnessType: snapshot.harnessType ?? fallbackHarnessForBenchmark(snapshot.benchmarkName),
  }
}

function fallbackHarnessForBenchmark(benchmarkName: StoredJob['snapshot']['benchmarkName']) {
  if (benchmarkName === 'swebench-lite') {
    return 'swebench-official' as const
  }
  if (benchmarkName === 'swe-polybench') {
    return 'swe-polybench-docker' as const
  }
  if (benchmarkName === 'terminal-bench') {
    return 'terminal-bench-docker' as const
  }
  return 'native' as const
}

function snapshotChangedFields(stored: StoredJob['snapshot'], fresh: StoredJob['snapshot']) {
  return [...new Set([...Object.keys(stored), ...Object.keys(fresh)])]
    .sort()
    .filter(
      (key) =>
        contentDigest((stored as unknown as Record<string, unknown>)[key]) !==
        contentDigest((fresh as unknown as Record<string, unknown>)[key]),
    )
}
