import { z } from 'zod'
import { parseWithSchema } from '@codeden/core/errors/codeden-error.js'

const SuiteNameSchema = z.enum(['regression', 'validation', 'holdout'])
type SuiteName = z.infer<typeof SuiteNameSchema>

const SuiteEvidenceSchema = z
  .object({
    name: SuiteNameSchema,
    total: z.number().int().positive(),
    passed: z.number().int().nonnegative(),
    caseSetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .refine((suite) => suite.passed <= suite.total, { message: 'Passed cannot exceed total' })

export const ReleaseEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    provenance: z.literal('eval-runner'),
    sourceRunIds: z.array(z.string().min(1)).min(1),
    agentVersion: z.string().min(1),
    agentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    datasetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    graderDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    environmentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    suites: z.array(SuiteEvidenceSchema).min(1),
    infrastructureFailures: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    tokenUsageCoverage: z.number().min(0).max(1),
    p95LatencyMs: z.number().nonnegative(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (new Set(evidence.sourceRunIds).size !== evidence.sourceRunIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['sourceRunIds'],
        message: 'Run ids must be unique',
      })
    }
    const names = evidence.suites.map((suite) => suite.name)
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', path: ['suites'], message: 'Suite names must be unique' })
    }
  })

export type ReleaseEvidence = z.infer<typeof ReleaseEvidenceSchema>

export interface ReleaseGateCheck {
  id: string
  passed: boolean
  blocking: boolean
  message: string
}

export interface ReleaseGateDecision {
  promote: boolean
  checks: ReleaseGateCheck[]
  warnings: ReleaseGateCheck[]
}

export interface ReleaseGatePolicy {
  minHoldoutCases?: number
  maxPassRateDrop?: number
  maxInfrastructureFailureRate?: number
  maxTokenIncreaseRatio?: number
  maxLatencyIncreaseRatio?: number
  minTokenUsageCoverage?: number
  requiredSuites?: SuiteName[]
}

const ReleaseGatePolicySchema = z
  .object({
    minHoldoutCases: z.number().int().positive().optional(),
    maxPassRateDrop: z.number().min(0).max(1).optional(),
    maxInfrastructureFailureRate: z.number().min(0).max(1).optional(),
    maxTokenIncreaseRatio: z.number().positive().optional(),
    maxLatencyIncreaseRatio: z.number().positive().optional(),
    minTokenUsageCoverage: z.number().min(0).max(1).optional(),
    requiredSuites: z.array(SuiteNameSchema).min(1).optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      policy.requiredSuites &&
      (policy.requiredSuites.length !== 3 ||
        new Set(policy.requiredSuites).size !== 3 ||
        !['regression', 'validation', 'holdout'].every((suite) =>
          policy.requiredSuites?.includes(suite as SuiteName),
        ))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requiredSuites'],
        message: 'Required suites must contain regression, validation and holdout exactly once',
      })
    }
  })

export function evaluateReleaseGate(
  championInput: ReleaseEvidence,
  challengerInput: ReleaseEvidence,
  policy: ReleaseGatePolicy = {},
): ReleaseGateDecision {
  const champion = parseReleaseEvidence(championInput)
  const challenger = parseReleaseEvidence(challengerInput)
  const parsedPolicy = parseWithSchema(
    ReleaseGatePolicySchema,
    policy,
    'Invalid release gate policy',
  )
  const minHoldoutCases = parsedPolicy.minHoldoutCases ?? 100
  const maxPassRateDrop = parsedPolicy.maxPassRateDrop ?? 0
  const maxInfrastructureFailureRate = parsedPolicy.maxInfrastructureFailureRate ?? 0.01
  const requiredSuites = parsedPolicy.requiredSuites ?? ['regression', 'validation', 'holdout']
  const championHoldout = suite(champion, 'holdout')
  const challengerHoldout = suite(challenger, 'holdout')
  const sameSuiteCoverage = requiredSuites.every((name) => {
    const championSuite = suite(champion, name)
    const challengerSuite = suite(challenger, name)
    return Boolean(
      championSuite &&
      challengerSuite &&
      championSuite.total === challengerSuite.total &&
      championSuite.caseSetDigest === challengerSuite.caseSetDigest,
    )
  })
  const suitesDoNotRegress =
    sameSuiteCoverage &&
    requiredSuites.every((name) => {
      const championSuite = suite(champion, name)
      const challengerSuite = suite(challenger, name)
      return Boolean(
        championSuite &&
        challengerSuite &&
        passRate(challengerSuite) >= passRate(championSuite) - maxPassRateDrop,
      )
    })
  const totalCases = challenger.suites.reduce((total, item) => total + item.total, 0)
  const checks: ReleaseGateCheck[] = [
    gate(
      'evidence.distinct_runs',
      !champion.sourceRunIds.some((id) => challenger.sourceRunIds.includes(id)),
      true,
      'Champion 与 Challenger 不得复用同一执行结果',
    ),
    gate(
      'efficiency.token_usage_coverage',
      champion.tokenUsageCoverage > 0 &&
        challenger.tokenUsageCoverage > 0 &&
        Math.min(champion.tokenUsageCoverage, challenger.tokenUsageCoverage) >=
          (parsedPolicy.minTokenUsageCoverage ?? 1),
      true,
      'Champion 或 Challenger 的 Token usage 采集覆盖率不足',
    ),
    gate(
      'evidence.distinct_agent',
      champion.agentDigest !== challenger.agentDigest,
      true,
      'Challenger 必须绑定与 Champion 不同的 Agent 配置摘要',
    ),
    gate(
      'evidence.same_dataset',
      champion.datasetDigest === challenger.datasetDigest,
      true,
      'Champion 和 Challenger 必须使用同一数据集版本',
    ),
    gate(
      'evidence.same_grader',
      champion.graderDigest === challenger.graderDigest,
      true,
      'Champion 和 Challenger 必须使用同一 Grader 版本',
    ),
    gate(
      'evidence.same_environment',
      champion.environmentDigest === challenger.environmentDigest,
      true,
      'Champion 和 Challenger 必须使用同一运行环境',
    ),
    gate(
      'evidence.suite_coverage',
      sameSuiteCoverage,
      true,
      'Champion 和 Challenger 必须覆盖样本数相同的必需评测集',
    ),
    gate(
      'evidence.holdout_coverage',
      Boolean(
        championHoldout &&
        challengerHoldout &&
        championHoldout.total === challengerHoldout.total &&
        challengerHoldout.total >= minHoldoutCases,
      ),
      true,
      `holdout 必须覆盖至少 ${minHoldoutCases} 个相同样本`,
    ),
    gate(
      'quality.suite_non_regression',
      suitesDoNotRegress,
      true,
      'Challenger 的必需评测集通过率不得超过允许范围地回退',
    ),
    gate(
      'infrastructure.failure_rate',
      totalCases > 0 &&
        challenger.infrastructureFailures / totalCases <= maxInfrastructureFailureRate,
      true,
      'Challenger 的基础设施失败率超过门限',
    ),
    gate(
      'efficiency.tokens',
      ratio(challenger.totalTokens, champion.totalTokens) <=
        (parsedPolicy.maxTokenIncreaseRatio ?? 1.2),
      false,
      'Challenger 的 Token 消耗升高',
    ),
    gate(
      'efficiency.latency',
      ratio(challenger.p95LatencyMs, champion.p95LatencyMs) <=
        (parsedPolicy.maxLatencyIncreaseRatio ?? 1.25),
      false,
      'Challenger 的 P95 延迟升高',
    ),
  ]
  return {
    promote: checks.every((item) => !item.blocking || item.passed),
    checks,
    warnings: checks.filter((item) => !item.blocking && !item.passed),
  }
}

export function parseReleaseEvidence(input: unknown): ReleaseEvidence {
  return parseWithSchema(ReleaseEvidenceSchema, input, 'Invalid release evidence')
}

function suite(evidence: ReleaseEvidence, name: SuiteName) {
  return evidence.suites.find((item) => item.name === name)
}

function passRate(value: { total: number; passed: number }): number {
  return value.passed / value.total
}

function ratio(challenger: number, champion: number): number {
  if (champion === 0) {
    return challenger === 0 ? 1 : Number.POSITIVE_INFINITY
  }
  return challenger / champion
}

function gate(id: string, passed: boolean, blocking: boolean, message: string): ReleaseGateCheck {
  return { id, passed, blocking, message }
}
