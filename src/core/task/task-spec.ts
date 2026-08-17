import { z } from 'zod'
import { parseWithSchema } from '../errors/codeden-error.js'

export const TaskSpecSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  allowedPaths: z.array(z.string().min(1)).default(['.']),
  verificationCommands: z.array(z.string().min(1)).default([]),
})

export type TaskSpec = z.infer<typeof TaskSpecSchema>

export function parseTaskSpec(input: unknown): TaskSpec {
  return parseWithSchema(TaskSpecSchema, input, 'Invalid TaskSpec')
}
