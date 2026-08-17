import { z } from 'zod'
import { CodeDenError } from '../errors/codeden-error.js'
import { ErrorCodes } from '../errors/error-codes.js'

export const AgentStateSchema = z.enum([
  'CREATED',
  'RUNNING',
  'MODEL_PROPOSED_COMPLETE',
  'SUBMITTED',
  'TIMEOUT',
  'BUDGET_EXHAUSTED',
  'FAILED',
])

export type AgentState = z.infer<typeof AgentStateSchema>

const ALLOWED_TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  CREATED: ['RUNNING'],
  RUNNING: ['MODEL_PROPOSED_COMPLETE', 'TIMEOUT', 'BUDGET_EXHAUSTED', 'FAILED'],
  MODEL_PROPOSED_COMPLETE: ['SUBMITTED', 'FAILED'],
  SUBMITTED: [],
  TIMEOUT: [],
  BUDGET_EXHAUSTED: [],
  FAILED: [],
}

export class AgentStateMachine {
  private current: AgentState = 'CREATED'

  get state(): AgentState {
    return this.current
  }

  transition(next: AgentState): AgentState {
    const allowed = ALLOWED_TRANSITIONS[this.current]
    if (!allowed.includes(next)) {
      throw new CodeDenError({
        code: ErrorCodes.INTERNAL_INVARIANT_VIOLATION,
        category: 'internal',
        message: `Illegal agent state transition: ${this.current} -> ${next}`,
        retryable: false,
        details: { from: this.current, to: next },
      })
    }
    this.current = next
    return this.current
  }
}
