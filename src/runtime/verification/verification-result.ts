import { z } from 'zod'
import type { VerifiedWorkspaceSnapshot } from '../attempts/verified-workspace-snapshot.js'
import { VerifiedWorkspaceSnapshotSchema } from '../attempts/verified-workspace-snapshot.js'

export const VerificationStepResultSchema = z.object({
  stepId: z.string().min(1),
  kind: z.enum(['diff', 'test', 'typecheck', 'lint', 'build', 'command']),
  status: z.enum(['passed', 'failed', 'skipped', 'error']),
  required: z.boolean(),
  durationMs: z.number().nonnegative(),
  message: z.string(),
  evidence: z.array(z.string()),
})

export type VerificationStepResult = z.infer<typeof VerificationStepResultSchema>

export interface CompletionCheck {
  passed: boolean
  message: string
  evidence: string[]
  stepResults?: VerificationStepResult[]
  verifiedSnapshot?: VerifiedWorkspaceSnapshot
}

export const CompletionCheckSchema: z.ZodType<CompletionCheck> = z.object({
  passed: z.boolean(),
  message: z.string(),
  evidence: z.array(z.string()),
  stepResults: z.array(VerificationStepResultSchema).optional(),
  verifiedSnapshot: VerifiedWorkspaceSnapshotSchema.optional(),
})

export function mergeChecks(checks: CompletionCheck[]): CompletionCheck {
  const failed = checks.filter((check) => !check.passed)
  if (failed.length === 0) {
    return {
      passed: true,
      message: 'Completion verification passed',
      evidence: checks.flatMap((check) => check.evidence),
      stepResults: checks.flatMap((check) => check.stepResults ?? []),
    }
  }
  return {
    passed: false,
    message: failed.map((check) => check.message).join('; '),
    evidence: failed.flatMap((check) => check.evidence),
    stepResults: checks.flatMap((check) => check.stepResults ?? []),
  }
}
