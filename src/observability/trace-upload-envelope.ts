import { z } from 'zod'
import { createHash } from 'node:crypto'
import { parseWithSchema } from '../core/errors/codeden-error.js'
import { parseRunEvent, type RunEvent } from '../core/events/run-event.js'

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
    traceId: hashIdentifier(`${runId}:${trialId}`),
    runIdHash,
    trialIdHash,
    eventCount: events.length,
    eventCounts,
    ...(events[0] ? { firstTimestamp: events[0].timestamp } : {}),
    ...(events.at(-1) ? { lastTimestamp: events.at(-1)!.timestamp } : {}),
    privacy: {
      mode: 'metadata_only',
      consentId: consent.consentId,
      redactionVersion: 1,
    },
  })
}

export function parseTraceUploadEnvelope(input: unknown): TraceUploadEnvelope {
  return parseWithSchema(TraceUploadEnvelopeSchema, input, 'Invalid trace upload envelope')
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
