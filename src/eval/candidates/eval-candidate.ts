import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CodeDenError, parseWithSchema } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import { EvalCaseSchema } from '../domain/eval-case.js'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

export const EvalCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    source: z
      .object({
        traceIdHash: sha256,
        signal: z.enum([
          'negative_feedback',
          'user_correction',
          'verification_failure',
          'sampled_success',
        ]),
      })
      .strict(),
    fingerprint: sha256,
    fixture: z
      .object({
        kind: z.enum(['synthetic', 'repository']),
        contentSha256: sha256,
        containsUserCode: z.boolean(),
        license: z.string().min(1),
        isolation: z.enum(['container', 'process']),
      })
      .strict(),
    privacy: z
      .object({
        status: z.enum(['pending', 'approved', 'rejected']),
        detectorVersion: z.string().min(1),
        findingCount: z.number().int().nonnegative(),
      })
      .strict(),
    reproduction: z
      .object({
        status: z.enum(['pending', 'passed', 'failed']),
        runs: z.number().int().nonnegative(),
        successes: z.number().int().nonnegative(),
        environmentDigest: sha256,
        graderDigest: sha256,
      })
      .strict()
      .refine((value) => value.successes <= value.runs, {
        message: 'Reproduction successes cannot exceed runs',
      }),
    humanReview: z
      .object({
        required: z.boolean(),
        status: z.enum(['pending', 'approved', 'rejected', 'not_required']),
        reviewId: z.string().min(1).optional(),
      })
      .strict(),
    evalCase: EvalCaseSchema,
    createdAt: z.iso.datetime(),
  })
  .strict()

const EvalCandidateInputSchema = EvalCandidateSchema.omit({ fingerprint: true })

export type EvalCandidate = z.infer<typeof EvalCandidateSchema>
export type EvalCandidateInput = z.input<typeof EvalCandidateInputSchema>

export interface CandidateGateCheck {
  id: string
  passed: boolean
  blocking: boolean
  message: string
}

export interface CandidateGateDecision {
  status: 'accepted' | 'rejected'
  checks: CandidateGateCheck[]
}

export function parseEvalCandidate(input: unknown): EvalCandidate {
  const candidate = parseWithSchema(EvalCandidateSchema, input, 'Invalid eval candidate')
  const expected = computeCandidateFingerprint(candidate)
  if (candidate.fingerprint !== expected) {
    throw new CodeDenError({
      code: ErrorCodes.INVALID_INPUT,
      category: 'validation',
      message: 'Invalid eval candidate fingerprint',
      retryable: false,
      details: { expected, actual: candidate.fingerprint },
    })
  }
  return candidate
}

export function createEvalCandidate(input: EvalCandidateInput): EvalCandidate {
  const candidate = parseWithSchema(EvalCandidateInputSchema, input, 'Invalid eval candidate')
  return {
    ...candidate,
    fingerprint: computeCandidateFingerprint(candidate),
  }
}

export function computeCandidateFingerprint(
  candidate: Pick<EvalCandidate, 'fixture' | 'evalCase'>,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        fixture: candidate.fixture,
        task: candidate.evalCase.task,
        persona: candidate.evalCase.persona,
        submission: candidate.evalCase.submission,
        verification: candidate.evalCase.verification,
      }),
    )
    .digest('hex')
}

export function evaluateCandidateGate(
  candidate: EvalCandidate,
  existingFingerprints: ReadonlySet<string>,
): CandidateGateDecision {
  const checks: CandidateGateCheck[] = [
    check(
      'privacy.approved',
      candidate.privacy.status === 'approved' && candidate.privacy.findingCount === 0,
      '隐私检测必须通过且无遗留发现',
    ),
    check(
      'privacy.no_user_code',
      !candidate.fixture.containsUserCode,
      'fixture 不得包含原始用户代码',
    ),
    check(
      'fixture.isolated',
      candidate.fixture.isolation === 'container',
      'fixture 必须在容器中隔离执行',
    ),
    check(
      'fixture.licensed',
      candidate.fixture.license.trim().toLowerCase() !== 'unknown',
      'fixture 必须具有明确的授权信息',
    ),
    check(
      'reproduction.stable',
      candidate.reproduction.status === 'passed' &&
        candidate.reproduction.runs >= 2 &&
        candidate.reproduction.successes === candidate.reproduction.runs,
      '候选必须在固定环境和 Grader 下至少稳定复现两次',
    ),
    check(
      'review.completed',
      candidate.humanReview.required
        ? candidate.humanReview.status === 'approved' && Boolean(candidate.humanReview.reviewId)
        : candidate.humanReview.status === 'not_required',
      '必须完成所需的人工复审',
    ),
    check(
      'dataset.unique',
      !existingFingerprints.has(candidate.fingerprint),
      '候选不得与现有评测样本重复',
    ),
  ]
  return {
    status: checks.some((item) => item.blocking && !item.passed) ? 'rejected' : 'accepted',
    checks,
  }
}

function check(id: string, passed: boolean, message: string): CandidateGateCheck {
  return { id, passed, blocking: true, message }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
