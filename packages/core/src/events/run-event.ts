import { z } from 'zod'
import { parseWithSchema } from '../errors/codeden-error.js'

export const RunEventSourceSchema = z.enum([
  'eval',
  'agent',
  'model',
  'tool',
  'workspace',
  'verifier',
  'harness',
  'grader',
  'infrastructure',
])

export type RunEventSource = z.infer<typeof RunEventSourceSchema>

export const RunEventSchema = z.object({
  schemaVersion: z.literal(1),
  /** 全局唯一事件 ID；旧 Trace 允许缺省。 */
  eventId: z.string().min(1).optional(),
  /** 平台 Job ID；旧的本地 Trace 允许缺省。 */
  jobId: z.string().min(1).optional(),
  /** Job 下的评测集执行 ID；旧的本地 Trace 允许缺省。 */
  benchmarkRunId: z.string().min(1).optional(),
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
