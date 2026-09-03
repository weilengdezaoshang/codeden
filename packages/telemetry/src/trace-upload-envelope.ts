import { z } from 'zod'
import { createHash } from 'node:crypto'
import { parseWithSchema } from '@codeden/core/errors/codeden-error.js'
import { parseRunEvent, type RunEvent } from '@codeden/core/events/run-event.js'
import { TrialMetricsSchema } from '@codeden/core/metrics.js'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

export const TraceUploadEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    traceId: z.string().regex(/^[a-f0-9]{64}$/u),
    runIdHash: z.string().regex(/^[a-f0-9]{64}$/u),
    trialIdHash: z.string().regex(/^[a-f0-9]{64}$/u),
    eventCount: z.number().int().nonnegative(),
    eventCounts: z.record(z.string(), z.number().int().nonnegative()),
    firstTimestamp: z.iso.datetime().optional(),
    lastTimestamp: z.iso.datetime().optional(),
    trace: z.object({ completed: z.boolean(), truncated: z.boolean() }).strict().optional(),
    tokens: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        requests: z.number().int().nonnegative(),
        measuredRequests: z.number().int().nonnegative(),
        status: z.enum(['complete', 'partial', 'unavailable']),
        collectionComplete: z.boolean().optional(),
      })
      .strict()
      .optional(),
    prompt: z
      .object({
        digest: sha256,
        personaDigest: sha256.optional(),
        hasRuntimePersona: z.boolean(),
      })
      .strict()
      .optional(),
    privacy: z
      .object({
        mode: z.literal('metadata_only'),
        consentId: z.string().min(1),
        redactionVersion: z.literal(1),
      })
      .strict(),
  })
  .strict()

export type TraceUploadEnvelope = z.infer<typeof TraceUploadEnvelopeSchema>

const UPLOADABLE_EVENT_TYPES = new Set([
  'agent.started',
  'agent.completed',
  'trace.truncated',
  'agent.instructions_loaded',
  'agent.prompt_composed',
  'agent.completion_proposed',
  'agent.submitted',
  'model.requested',
  'model.text_delta',
  'model.failed',
  'model.completed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'verification.started',
  'verification.completed',
  'verification.failed',
  'workspace.prepared',
  'workspace.disposed',
  'eval.trial.started',
  'eval.trial.completed',
])

export function buildMetadataUploadEnvelope(
  inputEvents: readonly RunEvent[],
  consent: {
    granted: boolean
    consentId?: string
    runId?: string
    trialId?: string
  },
): TraceUploadEnvelope {
  if (!consent.granted || !consent.consentId) {
    throw new Error('Trace upload consent is required')
  }
  const events = inputEvents.map(parseRunEvent)
  const runId = events[0]?.runId ?? consent.runId
  const trialId = events[0]?.trialId ?? consent.trialId
  if (!runId || !trialId) {
    throw new Error('Trace identifiers are required')
  }
  if (events.some((event) => event.runId !== runId || event.trialId !== trialId)) {
    throw new Error('Trace events must belong to one run and trial')
  }
  const eventCounts: Record<string, number> = {}
  for (const event of events) {
    const safeType = UPLOADABLE_EVENT_TYPES.has(event.type) ? event.type : 'other'
    const key = `${event.source}:${safeType}`
    eventCounts[key] = (eventCounts[key] ?? 0) + 1
  }
  const runIdHash = hashIdentifier(runId)
  const trialIdHash = hashIdentifier(trialId)
  return parseTraceUploadEnvelope({
    schemaVersion: 1,
    traceId: traceIdentifier(runId, trialId),
    runIdHash,
    trialIdHash,
    eventCount: events.length,
    eventCounts,
    ...(events[0] ? { firstTimestamp: events[0].timestamp } : {}),
    ...(events.at(-1) ? { lastTimestamp: events.at(-1)!.timestamp } : {}),
    ...evaluationMetadata(events),
    privacy: {
      mode: 'metadata_only',
      consentId: consent.consentId,
      redactionVersion: 1,
    },
  })
}

function evaluationMetadata(events: readonly RunEvent[]) {
  const root = events.filter((event) => !record(event.data).agentDepth)
  const completed = root.filter((event) => event.type === 'agent.completed').at(-1)
  const metrics = TrialMetricsSchema.safeParse(record(completed?.data).metrics)
  const usage = metrics.success ? metrics.data.tokenUsage : undefined
  const prompt = record(root.filter((event) => event.type === 'agent.prompt_composed').at(-1)?.data)
  const promptDigest = sha256.safeParse(prompt.promptDigest)
  const personaDigest = sha256.safeParse(prompt.personaDigest)
  return {
    trace: {
      completed: Boolean(completed),
      truncated: events.some(
        (event) => event.type === 'trace.truncated' || record(event.data).truncated === true,
      ),
    },
    ...(metrics.success && usage && usage.totalRequests === metrics.data.modelRequests
      ? {
          tokens: {
            input: metrics.data.inputTokens,
            output: metrics.data.outputTokens,
            requests: metrics.data.modelRequests,
            measuredRequests: usage.measuredRequests,
            status: usage.status,
            ...(usage.collectionComplete !== undefined
              ? { collectionComplete: usage.collectionComplete }
              : {}),
          },
        }
      : {}),
    ...(promptDigest.success
      ? {
          prompt: {
            digest: promptDigest.data,
            hasRuntimePersona: prompt.hasPersona === true,
            ...(personaDigest.success ? { personaDigest: personaDigest.data } : {}),
          },
        }
      : {}),
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function parseTraceUploadEnvelope(input: unknown): TraceUploadEnvelope {
  return parseWithSchema(TraceUploadEnvelopeSchema, input, 'Invalid trace upload envelope')
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function traceIdentifier(runId: string, trialId: string): string {
  return hashIdentifier(`${runId}:${trialId}`)
}
