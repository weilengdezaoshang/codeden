import { CodeDenError } from '../../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../../core/errors/error-codes.js'
import { parseRunEvent, type RunEvent } from '../../../core/events/run-event.js'
import { parseEvalRun, type EvalRun } from '../../domain/eval-run.js'
import { parseTrialResult, type TrialResult } from '../../domain/trial-result.js'
import type { EvalRepository } from '../../ports/eval-repository.port.js'
import type { SecretLeakGuard } from '../../../security/secret-leak-guard.js'

export class InMemoryEvalRepository implements EvalRepository {
  private readonly runs = new Map<string, EvalRun>()
  private readonly trials = new Map<string, TrialResult>()
  private readonly events = new Map<string, RunEvent[]>()

  constructor(private readonly guard?: SecretLeakGuard) {}

  async createRun(run: EvalRun): Promise<void> {
    const parsed = parseEvalRun(run)
    this.runs.set(parsed.runId, structuredClone(parsed))
  }

  async appendEvent(event: RunEvent): Promise<void> {
    this.guard?.assertSafe(event, `event:${event.type}`)
    const parsed = parseRunEvent(event)
    const list = this.events.get(parsed.trialId) ?? []
    const last = list.at(-1)
    if (list.some((item) => item.sequence === parsed.sequence)) {
      throw new CodeDenError({
        code: ErrorCodes.INTERNAL_INVARIANT_VIOLATION,
        category: 'internal',
        message: `Duplicate event sequence ${parsed.sequence}`,
        retryable: false,
        details: { trialId: parsed.trialId, sequence: parsed.sequence },
      })
    }
    if (last && parsed.sequence <= last.sequence) {
      throw new CodeDenError({
        code: ErrorCodes.INTERNAL_INVARIANT_VIOLATION,
        category: 'internal',
        message: `Event sequence went backwards: ${last.sequence} -> ${parsed.sequence}`,
        retryable: false,
        details: { trialId: parsed.trialId, previous: last.sequence, sequence: parsed.sequence },
      })
    }
    list.push(structuredClone(parsed))
    this.events.set(parsed.trialId, list)
  }

  async saveTrial(result: TrialResult): Promise<void> {
    this.guard?.assertSafe(result, `trial:${result.trialId}`)
    const parsed = parseTrialResult(result)
    this.trials.set(parsed.trialId, structuredClone(parsed))
  }

  async getRun(runId: string): Promise<EvalRun | null> {
    const run = this.runs.get(runId)
    return run ? structuredClone(run) : null
  }

  async getTrial(trialId: string): Promise<TrialResult | null> {
    const trial = this.trials.get(trialId)
    return trial ? structuredClone(trial) : null
  }

  async getEvents(trialId: string): Promise<RunEvent[]> {
    return structuredClone(this.events.get(trialId) ?? [])
  }

  async listTrials(runId: string): Promise<TrialResult[]> {
    return [...this.trials.values()]
      .filter((trial) => trial.runId === runId)
      .map((trial) => structuredClone(trial))
  }
}
