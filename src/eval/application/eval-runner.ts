import type { Clock } from '../../core/clock.js'
import { SystemClock } from '../../core/clock.js'
import { createId } from '../../core/ids.js'
import type { EvalCase } from '../domain/eval-case.js'
import type { EvalRun } from '../domain/eval-run.js'
import type { TrialResult } from '../domain/trial-result.js'
import type { AgentPort } from '../ports/agent.port.js'
import type { BenchmarkPort } from '../ports/benchmark.port.js'
import type { EvalRepository } from '../ports/eval-repository.port.js'
import type { WorkspaceFactory } from '../ports/workspace.port.js'
import type { SecurityServices } from '../../security/security-services.js'
import type { ConsoleReporter } from '../reporters/console.reporter.js'
import { TrialRunner } from './trial-runner.js'

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
  trials: TrialResult[]
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
}

export class EvalRunner {
  private readonly trialRunner: TrialRunner
  private readonly repository: EvalRepository
  private readonly reporter: ConsoleReporter | undefined
  private readonly agentName: string
  private readonly clock: Clock

  constructor(deps: EvalRunnerDeps) {
    this.trialRunner = new TrialRunner(deps)
    this.repository = deps.repository
    this.reporter = deps.reporter
    this.agentName = deps.agent.name
    this.clock = deps.clock ?? new SystemClock()
  }

  async run(cases: EvalCase[]): Promise<EvalRunSummary> {
    const runId = createId()
    const started = this.clock.monotonicMs()
    const run: EvalRun = {
      schemaVersion: 1,
      runId,
      startedAt: this.clock.now().toISOString(),
      status: 'running',
      caseIds: cases.map((item) => item.id),
      agentName: this.agentName,
    }
    await this.repository.createRun(run)

    const trials: TrialResult[] = []
    for (const evalCase of cases) {
      trials.push(await this.trialRunner.run({ runId, evalCase }))
    }

    const summary = summarize(runId, trials, Math.max(0, this.clock.monotonicMs() - started))
    await this.repository.updateRun({ ...run, status: 'completed' })
    this.reporter?.report(summary, this.agentName)
    return summary
  }
}

export function summarize(
  runId: string,
  trials: TrialResult[],
  durationMs: number,
): EvalRunSummary {
  const passedCases = trials.filter((trial) => trial.resolved).length
  const infrastructureErrors = trials.filter((trial) => trial.infrastructure.status !== 'ok').length
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
    trials,
    allResolved: trials.length > 0 && trials.every((trial) => trial.resolved),
    infrastructureFailed:
      infrastructureErrors > 0 &&
      passedCases === 0 &&
      trials.every((trial) => trial.infrastructure.status !== 'ok'),
  }
}
