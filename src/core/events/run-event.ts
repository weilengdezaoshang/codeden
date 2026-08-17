import { z } from 'zod'
import { parseWithSchema } from '../errors/codeden-error.js'

export const RunEventSourceSchema = z.enum([
  'eval',
  'agent',
  'model',
  'tool',
  'workspace',
  'verifier',
])

export type RunEventSource = z.infer<typeof RunEventSourceSchema>

export const RunEventSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  trialId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.iso.datetime(),
  source: RunEventSourceSchema,
  type: z.string().min(1),
  data: z.unknown(),
})

export type RunEvent = z.infer<typeof RunEventSchema>

export function parseRunEvent(input: unknown): RunEvent {
  return parseWithSchema(RunEventSchema, input, 'Invalid RunEvent')
}
