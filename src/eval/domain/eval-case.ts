import { z } from 'zod'
import { parseWithSchema } from '../../core/errors/codeden-error.js'
import { TaskSpecSchema } from '../../core/task/task-spec.js'

export const EvalCaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  suite: z.enum(['regression', 'training', 'validation', 'holdout']),
  tags: z.array(z.string()).default([]),
  metadata: z
    .object({
      source: z.string().min(1),
      version: z.string().optional(),
      upstreamId: z.string().optional(),
      license: z.string().optional(),
      repository: z.string().optional(),
      baseCommit: z.string().optional(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      verificationMode: z.enum(['disabled', 'host-opt-in', 'isolated']).optional(),
    })
    .optional(),
  task: z.object({
    prompt: z.string().min(1),
    taskSpec: TaskSpecSchema,
  }),
  fixture: z.object({
    path: z.string().min(1),
    repository: z
      .object({
        repository: z.string().min(1),
        baseCommit: z.string().min(1),
        testPatch: z.string(),
        environmentSetupCommit: z.string().optional(),
      })
      .optional(),
  }),
  limits: z.object({
    timeoutMs: z.number().int().positive(),
    maxTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
  }),
  submission: z.object({
    type: z.enum(['files', 'text']),
    allowedPaths: z.array(z.string()).default([]),
  }),
  verification: z.object({
    graders: z.array(z.unknown()).min(1),
  }),
})

export type EvalCase = z.infer<typeof EvalCaseSchema>

export function parseEvalCase(input: unknown): EvalCase {
  return parseWithSchema(EvalCaseSchema, input, 'Invalid EvalCase')
}
