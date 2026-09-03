import { z } from 'zod'
import { parseWithSchema } from '@codeden/core/errors/codeden-error.js'
import { TrialMetricsSchema } from '@codeden/core/metrics.js'
import { FailureDiagnosisSchema } from './failure-diagnosis.js'

export const TrialExecutionStatusSchema = z.enum([
  'submitted',
  'timeout',
  'budget_exhausted',
  'agent_error',
])

export const TrialResultSchema = z.object({
  schemaVersion: z.literal(1),
  /** 平台 Job ID；本地离线评测可以缺省。 */
  jobId: z.string().min(1).optional(),
  /** Job 下的评测集执行 ID；兼容旧结果时可以缺省。 */
  benchmarkRunId: z.string().min(1).optional(),
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
      diagnosis: FailureDiagnosisSchema.optional(),
    })
    .optional(),
  resolved: z.boolean(),
  scores: z.record(z.string(), z.number()),
  metrics: TrialMetricsSchema,
  diffs: z
    .array(
      z.object({
        path: z.string().min(1),
        before: z.string(),
        after: z.string(),
        binary: z.boolean().optional(),
      }),
    )
    .optional(),
  artifacts: z.array(z.string()).default([]),
})

export type TrialResult = z.infer<typeof TrialResultSchema>
export type TrialExecutionStatus = z.infer<typeof TrialExecutionStatusSchema>

/** 独立验证可以确认预算耗尽前已完成的文件修改，不依赖 Agent 自报完成。 */
export function isTrialResolved(
  trial: Pick<TrialResult, 'verification' | 'infrastructure'>,
): boolean {
  return trial.verification.status === 'passed' && trial.infrastructure.status === 'ok'
}

export function parseTrialResult(input: unknown): TrialResult {
  return parseWithSchema(TrialResultSchema, input, 'Invalid TrialResult')
}
