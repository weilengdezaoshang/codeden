import { z } from 'zod'
import { parseWithSchema } from '../../core/errors/codeden-error.js'

export const EvalRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  startedAt: z.iso.datetime(),
  status: z.enum(['running', 'completed', 'failed']),
  caseIds: z.array(z.string().min(1)),
  agentName: z.string().min(1),
})

export type EvalRun = z.infer<typeof EvalRunSchema>

export function parseEvalRun(input: unknown): EvalRun {
  return parseWithSchema(EvalRunSchema, input, 'Invalid EvalRun')
}
