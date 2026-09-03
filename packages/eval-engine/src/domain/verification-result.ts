import { z } from 'zod'
import { parseWithSchema } from '@codeden/core/errors/codeden-error.js'

export const GraderResultSchema = z.object({
  graderType: z.string().min(1),
  passed: z.boolean(),
  score: z.number(),
  message: z.string(),
  evidence: z.array(z.string()),
})

export type GraderResult = z.infer<typeof GraderResultSchema>

export const VerificationResultSchema = z.object({
  status: z.enum(['passed', 'failed', 'error']),
  scores: z.record(z.string(), z.number()),
  graderResults: z.array(GraderResultSchema).default([]),
  message: z.string().optional(),
})

export type VerificationResult = z.infer<typeof VerificationResultSchema>

export function parseVerificationResult(input: unknown): VerificationResult {
  return parseWithSchema(VerificationResultSchema, input, 'Invalid VerificationResult')
}
