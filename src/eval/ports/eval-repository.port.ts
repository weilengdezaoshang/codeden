import type { RunEvent } from '../../core/events/run-event.js'
import type { EvalRun } from '../domain/eval-run.js'
import type { TrialResult } from '../domain/trial-result.js'

export interface EvalRepository {
  createRun(run: EvalRun): Promise<void>
  updateRun(run: EvalRun): Promise<void>
  appendEvent(event: RunEvent): Promise<void>
  saveTrial(result: TrialResult): Promise<void>
  getRun(runId: string): Promise<EvalRun | null>
  getTrial(trialId: string): Promise<TrialResult | null>
  getEvents(trialId: string): Promise<RunEvent[]>
  listTrials(runId: string): Promise<TrialResult[]>
}
