import type { Clock } from '@codeden/core/clock.js'
import { SystemClock } from '@codeden/core/clock.js'
import { createId } from '@codeden/core/ids.js'
import type { EvalCase } from '../domain/eval-case.js'
import type { EvalRun, RunEvidence } from '../domain/eval-run.js'
import type { TrialResult } from '../domain/trial-result.js'
import type { AgentPort } from '@codeden/agent-runtime/agent/agent-contracts.js'
import type { BenchmarkPort } from '../ports/benchmark.port.js'
import type { EvalRepository } from '../ports/eval-repository.port.js'
import type { WorkspaceFactory } from '@codeden/core/workspace/workspace-contracts.js'
import type { SecurityServices } from '@codeden/core/security/security-services.js'
import type { ConsoleReporter } from '../reporters/console.reporter.js'
import { TrialRunner } from './trial-runner.js'
import type { FailureLayer, FailureStage } from '../domain/failure-diagnosis.js'

export interface FailureCluster {
  readonly key: string
  readonly count: number
  readonly caseIds: readonly string[]
  readonly category: string
  readonly layer?: FailureLayer
  readonly stage?: FailureStage
  readonly fingerprint?: string
}

export interface EvalRunSummary {
  runId: string
  totalCases: number
  passedCases: number
  failedCases: number
  infrastructureErrors: number
  passRate: number
  durationMs: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  modelRequests: number
  measuredTokenRequests: number
  tokenUsageCoverage: number
  p95LatencyMs: number
  trials: TrialResult[]
  failureClusters: FailureCluster[]
  allResolved: boolean
  infrastructureFailed: boolean
}

export interface EvalRunnerDeps {
  agent: AgentPort
  benchmark: BenchmarkPort
  workspaceFactory: WorkspaceFactory
  repository: EvalRepository
  reporter?: ConsoleReporter
  clock?: Clock
  security?: SecurityServices
  evidence?: RunEvidence
  trialConcurrency?: number
  /** 外部编排层提供时，使用固定的 BenchmarkRun ID。 */
  runId?: string
  /** 平台 Job ID，用于把事件路由回正确的任务。 */
  jobId?: string
  /** 平台评测集执行 ID，用于区分同一 Job 下的多个评测集。 */
  benchmarkRunId?: string
}

export class EvalRunner {
  private readonly trialRunner: TrialRunner
  private readonly repository: EvalRepository
  private readonly reporter: ConsoleReporter | undefined
  private readonly agentName: string
  private readonly clock: Clock
  private readonly evidence: RunEvidence | undefined
  private readonly runId: string | undefined
  private readonly jobId: string | undefined
  private readonly benchmarkRunId: string | undefined

  constructor(deps: EvalRunnerDeps) {
    this.trialRunner = new TrialRunner(deps)
    this.repository = deps.repository
    this.reporter = deps.reporter
    this.agentName = deps.agent.name
    this.clock = deps.clock ?? new SystemClock()
    this.evidence = deps.evidence
    this.runId = deps.runId
    this.jobId = deps.jobId
    this.benchmarkRunId = deps.benchmarkRunId ?? deps.runId
    this.trialConcurrency = deps.trialConcurrency ?? 1
  }

  private readonly trialConcurrency: number

  async run(cases: EvalCase[], signal?: AbortSignal): Promise<EvalRunSummary> {
    if (new Set(cases.map((item) => item.id)).size !== cases.length) {
      throw new Error('评测样本编号不得重复')
    }
    const runId = this.runId ?? createId()
    const started = this.clock.monotonicMs()
    const run: EvalRun = {
      schemaVersion: 1,
      runId,
      startedAt: this.clock.now().toISOString(),
      status: 'running',
      caseIds: cases.map((item) => item.id),
      agentName: this.agentName,
      ...(this.evidence ? { evidence: this.evidence } : {}),
    }
    await this.repository.createRun(run)

    const trials = await runWithConcurrency(
      cases,
      this.trialConcurrency,
      (evalCase) =>
        this.trialRunner.run({
          runId,
          jobId: this.jobId,
          benchmarkRunId: this.benchmarkRunId,
          evalCase,
          signal,
        }),
      signal,
    )

    const summary = summarize(runId, trials, Math.max(0, this.clock.monotonicMs() - started))
    await this.repository.updateRun({ ...run, status: 'completed' })
    this.reporter?.report(summary, this.agentName)
    return summary
  }
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('trialConcurrency 必须是正整数')
  }
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (true) {
      signal?.throwIfAborted()
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

export function summarize(
  runId: string,
  trials: TrialResult[],
  durationMs: number,
): EvalRunSummary {
  const passedCases = trials.filter((trial) => trial.resolved).length
  const infrastructureErrors = trials.filter((trial) => trial.infrastructure.status !== 'ok').length
  const modelRequests = trials.reduce((sum, trial) => sum + trial.metrics.modelRequests, 0)
  const measuredTokenRequests = trials.reduce(
    (sum, trial) => sum + (trial.metrics.tokenUsage?.measuredRequests ?? 0),
    0,
  )
  return {
    runId,
    totalCases: trials.length,
    passedCases,
    failedCases: trials.length - passedCases,
    infrastructureErrors,
    passRate: trials.length === 0 ? 0 : passedCases / trials.length,
    durationMs,
    toolCalls: trials.reduce((sum, trial) => sum + trial.metrics.toolCalls, 0),
    inputTokens: trials.reduce((sum, trial) => sum + trial.metrics.inputTokens, 0),
    outputTokens: trials.reduce((sum, trial) => sum + trial.metrics.outputTokens, 0),
    modelRequests,
    measuredTokenRequests,
    tokenUsageCoverage:
      modelRequests === 0 ||
      trials.some((trial) => trial.metrics.tokenUsage?.collectionComplete === false)
        ? 0
        : measuredTokenRequests / modelRequests,
    p95LatencyMs: percentile(
      trials.map((trial) => trial.metrics.durationMs),
      0.95,
    ),
    trials,
    failureClusters: groupFailureClusters(trials),
    allResolved: trials.length > 0 && trials.every((trial) => trial.resolved),
    infrastructureFailed:
      infrastructureErrors > 0 &&
      passedCases === 0 &&
      trials.every((trial) => trial.infrastructure.status !== 'ok'),
  }
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

/** Groups failed trials by diagnostic layer and stable failure fingerprint. */
export function groupFailureClusters(trials: readonly TrialResult[]): FailureCluster[] {
  const clusters = new Map<
    string,
    {
      category: string
      layer?: FailureLayer
      stage?: FailureStage
      fingerprint?: string
      caseIds: string[]
    }
  >()

  for (const trial of trials) {
    const failure = trial.failure
    if (!failure) {
      continue
    }
    const layer = failure.diagnosis?.layer
    const stage = failure.diagnosis?.stage
    const key = [
      failure.category,
      layer ?? 'unknown',
      stage ?? 'unknown',
      failure.fingerprint ?? 'no-fingerprint',
    ].join(':')
    const existing = clusters.get(key)
    if (existing) {
      existing.caseIds.push(trial.caseId)
      continue
    }
    clusters.set(key, {
      category: failure.category,
      ...(layer ? { layer } : {}),
      ...(stage ? { stage } : {}),
      ...(failure.fingerprint ? { fingerprint: failure.fingerprint } : {}),
      caseIds: [trial.caseId],
    })
  }

  return [...clusters.entries()]
    .map(([key, value]) => ({
      key,
      count: value.caseIds.length,
      caseIds: [...new Set(value.caseIds)],
      category: value.category,
      ...(value.layer ? { layer: value.layer } : {}),
      ...(value.stage ? { stage: value.stage } : {}),
      ...(value.fingerprint ? { fingerprint: value.fingerprint } : {}),
    }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}
