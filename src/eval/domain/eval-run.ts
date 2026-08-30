import { z } from 'zod'
import { parseWithSchema } from '../../core/errors/codeden-error.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const RunEvidenceSchema = z
  .object({
    agentDigest: digest,
    datasetDigest: digest,
    graderDigest: digest,
    environmentDigest: digest,
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            suite: z.enum(['regression', 'validation', 'holdout']),
            digest,
            graderDigest: digest.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
export type RunEvidence = z.infer<typeof RunEvidenceSchema>

export const EvalRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  startedAt: z.iso.datetime(),
  status: z.enum(['running', 'completed', 'failed']),
  caseIds: z.array(z.string().min(1)),
  agentName: z.string().min(1),
  evidence: RunEvidenceSchema.optional(),
})

export type EvalRun = z.infer<typeof EvalRunSchema>

export function parseEvalRun(input: unknown): EvalRun {
  return parseWithSchema(EvalRunSchema, input, 'Invalid EvalRun')
}
