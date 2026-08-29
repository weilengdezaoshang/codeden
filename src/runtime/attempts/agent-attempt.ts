import { z } from 'zod'
import { parseWithSchema } from '../../core/errors/codeden-error.js'
import { createId } from '../../core/ids.js'

export const AgentAttemptStateSchema = z.enum([
  'running',
  'completion_proposed',
  'verifying',
  'verified',
  'verification_failed',
  'stale',
  'writeback_ready',
  'applied',
  'failed',
  'cancelled',
])

export type AgentAttemptState = z.infer<typeof AgentAttemptStateSchema>

export const AgentAttemptSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: z.string().min(1),
    sessionId: z.string().min(1),
    turnIndex: z.number().int().positive(),
    taskSpecVersion: z.string().min(1),
    state: AgentAttemptStateSchema,
    initialRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    currentRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    verifiedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((attempt, context) => {
    if (Date.parse(attempt.updatedAt) < Date.parse(attempt.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'Attempt update time cannot precede its creation time',
      })
    }
    if (
      (attempt.state === 'verified' ||
        attempt.state === 'writeback_ready' ||
        attempt.state === 'applied') &&
      attempt.verifiedRevision !== attempt.currentRevision
    ) {
      context.addIssue({
        code: 'custom',
        path: ['verifiedRevision'],
        message: 'Verified state must reference the current workspace revision',
      })
    }
    if (attempt.state === 'stale' && attempt.verifiedRevision !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['verifiedRevision'],
        message: 'Stale attempt cannot keep a verified workspace revision',
      })
    }
  })

export type AgentAttempt = z.infer<typeof AgentAttemptSchema>

const transitions: Readonly<Record<AgentAttemptState, readonly AgentAttemptState[]>> = {
  running: ['completion_proposed', 'failed', 'cancelled'],
  completion_proposed: ['verifying', 'stale', 'failed', 'cancelled'],
  verifying: ['verified', 'verification_failed', 'stale', 'failed', 'cancelled'],
  verified: ['writeback_ready', 'stale', 'failed', 'cancelled'],
  verification_failed: ['running', 'failed', 'cancelled'],
  stale: ['running', 'failed', 'cancelled'],
  writeback_ready: ['applied', 'stale', 'failed', 'cancelled'],
  applied: [],
  failed: [],
  cancelled: [],
}

export function createAgentAttempt(input: {
  attemptId?: string
  sessionId: string
  turnIndex: number
  taskSpecVersion: string
  initialRevision: string
  now?: Date
}): AgentAttempt {
  const timestamp = (input.now ?? new Date()).toISOString()
  return parseAgentAttempt({
    schemaVersion: 1,
    attemptId: input.attemptId ?? createId(),
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    taskSpecVersion: input.taskSpecVersion,
    state: 'running',
    initialRevision: input.initialRevision,
    currentRevision: input.initialRevision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

export function transitionAttempt(
  attempt: AgentAttempt,
  nextState: AgentAttemptState,
  options: { verifiedRevision?: string; now?: Date } = {},
): AgentAttempt {
  if (!transitions[attempt.state].includes(nextState)) {
    throw new Error(`Invalid attempt transition: ${attempt.state} -> ${nextState}`)
  }
  if (nextState === 'verified' && options.verifiedRevision !== attempt.currentRevision) {
    throw new Error('Verified revision must match the current workspace revision')
  }
  if (
    (nextState === 'writeback_ready' || nextState === 'applied') &&
    attempt.verifiedRevision !== attempt.currentRevision
  ) {
    throw new Error('Attempt does not have a current verified workspace revision')
  }
  const verifiedRevision =
    nextState === 'verified'
      ? options.verifiedRevision
      : nextState === 'verification_failed' || nextState === 'running' || nextState === 'stale'
        ? undefined
        : attempt.verifiedRevision
  return parseAgentAttempt({
    ...attempt,
    state: nextState,
    ...(verifiedRevision ? { verifiedRevision } : { verifiedRevision: undefined }),
    updatedAt: (options.now ?? new Date()).toISOString(),
  })
}

export function recordAttemptRevision(
  attempt: AgentAttempt,
  workspaceRevision: string,
  now = new Date(),
): AgentAttempt {
  if (workspaceRevision === attempt.currentRevision) {
    return attempt
  }
  if (attempt.state === 'applied' || attempt.state === 'failed' || attempt.state === 'cancelled') {
    throw new Error('Cannot update a terminal attempt revision')
  }
  const mustInvalidate =
    attempt.state === 'completion_proposed' ||
    attempt.state === 'verifying' ||
    attempt.state === 'verified' ||
    attempt.state === 'writeback_ready'
  return parseAgentAttempt({
    ...attempt,
    state: mustInvalidate ? 'stale' : attempt.state,
    currentRevision: workspaceRevision,
    verifiedRevision: undefined,
    updatedAt: now.toISOString(),
  })
}

export function parseAgentAttempt(input: unknown): AgentAttempt {
  return parseWithSchema(AgentAttemptSchema, input, 'Invalid agent attempt')
}
