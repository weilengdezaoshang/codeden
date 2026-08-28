import { z } from 'zod'
import { parseWithSchema } from '../../core/errors/codeden-error.js'
import { TrialMetricsSchema } from './metrics.js'

export const TrialExecutionStatusSchema = z.enum([
  'submitted',
  'timeout',
  'budget_exhausted',
  'agent_error',
])

export const TrialResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  trialId: z.string().min(1),
  caseId: z.string().min(1),
  benchmark: z
    .object({
      name: z.string().min(1),
      version: z.string().optional(),
      upstreamId: z.string().optional(),
      license: z.string().optional(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      verificationMode: z.enum(['disabled', 'host-opt-in', 'isolated']).optional(),
    })
    .optional(),
  execution: z.object({
    status: TrialExecutionStatusSchema,
    stopReason: z.string().optional(),
  }),
  submission: z.object({
    status: z.enum(['valid', 'empty', 'invalid', 'missing']),
  }),
  verification: z.object({
    status: z.enum(['passed', 'failed', 'error']),
  }),
  infrastructure: z.object({
    status: z.enum(['ok', 'setup_error', 'runtime_error']),
  }),
  failure: z
    .object({
      category: z.enum([
        'infrastructure',
        'timeout',
        'budget',
        'submission',
        'verification',
        'agent',
      ]),
      message: z.string().min(1),
      identities: z.array(z.string()),
      fingerprint: z
        .string()
        .regex(/^[a-f0-9]{16}$/u)
        .optional(),
      evidence: z.array(z.string()),
    })
    .optional(),
  resolved: z.boolean(),
  scores: z.record(z.string(), z.number()),
  metrics: TrialMetricsSchema,
  artifacts: z.array(z.string()).default([]),
})

export type TrialResult = z.infer<typeof TrialResultSchema>
export type TrialExecutionStatus = z.infer<typeof TrialExecutionStatusSchema>

export function parseTrialResult(input: unknown): TrialResult {
  return parseWithSchema(TrialResultSchema, input, 'Invalid TrialResult')
}
