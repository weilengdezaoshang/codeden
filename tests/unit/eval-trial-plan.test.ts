import { describe, expect, it } from 'vitest'
import type { TrialResult } from '@codeden/eval-engine/domain/trial-result.js'
import {
  buildTrialPlans,
  deriveTrialOutcome,
  parsePlannedCaseId,
  plannedCaseSnapshotId,
} from '../../apps/eval-platform/src/platform/trial-plan.js'

describe('M1 · Trial 计划模型', () => {
  it('2 题 × 3 次生成 6 个计划行，身份唯一且顺序交错', () => {
    // 与 catalog.repeatCases 同构：轮次优先交错（c1, c2, c1#2, c2#2, c1#3, c2#3）
    const caseIds = [1, 2, 3].flatMap((rep) =>
      ['update-package-version', 'persona-concise'].map((id) => (rep === 1 ? id : `${id}#${rep}`)),
    )
    const plans = buildTrialPlans(caseIds)
    expect(plans).toHaveLength(6)
    expect(new Set(plans.map((p) => `${p.caseId}#${p.repetitionIndex}`)).size).toBe(6)
    expect(plans.map((p) => p.position)).toEqual([1, 2, 3, 4, 5, 6])
    // 轮次交错：按题目块分轮（2 题 → 位置 1-2 第 1 轮、3-4 第 2 轮、5-6 第 3 轮）
    expect(plans.slice(0, 2).every((p) => p.repetitionIndex === 1)).toBe(true)
    expect(plans.slice(2, 4).every((p) => p.repetitionIndex === 2)).toBe(true)
    expect(plans.slice(4, 6).every((p) => p.repetitionIndex === 3)).toBe(true)
  })

  it('解析计划编号：含 # 后缀与不含后缀', () => {
    expect(parsePlannedCaseId('case#12')).toEqual({ baseId: 'case', repetitionIndex: 12 })
    expect(parsePlannedCaseId('case')).toEqual({ baseId: 'case', repetitionIndex: 1 })
    expect(parsePlannedCaseId('weird#name#3')).toEqual({ baseId: 'weird#name', repetitionIndex: 3 })
  })

  it('M3：计划身份还原为快照题目 ID（第 1 次无后缀，其余带 #N）', () => {
    expect(plannedCaseSnapshotId('case-a', 1)).toBe('case-a')
    expect(plannedCaseSnapshotId('case-a', 3)).toBe('case-a#3')
  })

  it('M3：准备故障且未调用 Agent 才可重试（verdict/归因/阶段组合判定）', () => {
    const prepareFailure = deriveTrialOutcome(
      baseResult({ resolved: false, infrastructure: 'setup_error' }),
    )
    expect(prepareFailure).toMatchObject({
      verdict: 'unknown',
      errorCategory: 'env_failure',
      failureStage: 'prepare',
    })
    // Agent 已执行的运行时故障（runtime_error 但 execution submitted）同样是 env_failure/prepare 组合？——
    // runtime_error 发生在 Agent 之后：deriveTrialOutcome 对非 ok 一律 prepare 归类，
    // 因此重试资格必须再要求 metrics.modelRequests === 0（账本中读取），不能仅凭归因。
    const runtimeAfterAgent = deriveTrialOutcome(
      baseResult({ resolved: false, infrastructure: 'runtime_error' }),
    )
    expect(runtimeAfterAgent.errorCategory).toBe('env_failure')
  })

  it('verdict 口径：验证通过且环境正常 → pass', () => {
    const outcome = deriveTrialOutcome(baseResult({ resolved: true }))
    expect(outcome.verdict).toBe('pass')
    expect(outcome.failureStage).toBe('grade')
  })

  it('verdict 口径：断言未通过 → fail + assertion_failed', () => {
    const outcome = deriveTrialOutcome(
      baseResult({ resolved: false, verification: 'failed', failureCategory: 'verification' }),
    )
    expect(outcome.verdict).toBe('fail')
    expect(outcome.errorCategory).toBe('assertion_failed')
    expect(outcome.failureStage).toBe('verify')
  })

  it('verdict 口径：基础设施故障 → unknown + env_failure，不冒充能力失败', () => {
    const outcome = deriveTrialOutcome(
      baseResult({ resolved: false, infrastructure: 'setup_error' }),
    )
    expect(outcome.verdict).toBe('unknown')
    expect(outcome.errorCategory).toBe('env_failure')
    expect(outcome.failureStage).toBe('prepare')
  })

  it('verdict 口径：Agent 异常 → unknown + model_error', () => {
    const outcome = deriveTrialOutcome(baseResult({ resolved: false, execution: 'agent_error' }))
    expect(outcome.verdict).toBe('unknown')
    expect(outcome.errorCategory).toBe('model_error')
  })

  it('verdict 口径：判卷器故障 → unknown，评分失败不等于能力失败', () => {
    const outcome = deriveTrialOutcome(baseResult({ resolved: false, verification: 'error' }))
    expect(outcome.verdict).toBe('unknown')
    expect(outcome.failureStage).toBe('grade')
  })

  it('verdict 口径：超时且无有效验收 → unknown + timeout', () => {
    const outcome = deriveTrialOutcome(
      baseResult({ resolved: false, execution: 'timeout', verification: 'error' }),
    )
    expect(outcome.verdict).toBe('unknown')
    expect(outcome.errorCategory).toBe('timeout')
  })

  it('verdict 口径：超时但独立验收已失败 → fail（预算内超限可判失败）', () => {
    const outcome = deriveTrialOutcome(
      baseResult({ resolved: false, execution: 'timeout', verification: 'failed' }),
    )
    expect(outcome.verdict).toBe('fail')
  })

  it('提交缺失 → fail + submission_invalid', () => {
    const outcome = deriveTrialOutcome(
      baseResult({ resolved: false, verification: 'failed', failureCategory: 'submission' }),
    )
    expect(outcome.verdict).toBe('fail')
    expect(outcome.errorCategory).toBe('submission_invalid')
  })
})

type BaseOptions = {
  resolved: boolean
  verification?: 'passed' | 'failed' | 'error'
  infrastructure?: 'ok' | 'setup_error' | 'runtime_error'
  execution?: 'submitted' | 'timeout' | 'budget_exhausted' | 'agent_error'
  failureCategory?:
    'infrastructure' | 'timeout' | 'budget' | 'submission' | 'verification' | 'agent'
}

function baseResult(options: BaseOptions): TrialResult {
  const verification = options.verification ?? 'passed'
  const infrastructure = options.infrastructure ?? 'ok'
  const execution = options.execution ?? 'submitted'
  return {
    schemaVersion: 1,
    runId: 'run-1',
    trialId: 'trial-1',
    caseId: 'case-1',
    execution: { status: execution },
    submission: { status: verification === 'passed' ? 'valid' : 'empty' },
    verification: { status: verification },
    infrastructure: { status: infrastructure },
    ...(options.failureCategory
      ? {
          failure: {
            category: options.failureCategory,
            message: '失败详情',
            identities: [],
            evidence: [],
          },
        }
      : {}),
    resolved: options.resolved,
    scores: {},
    metrics: {
      durationMs: 1,
      turns: 0,
      modelRequests: 0,
      toolCalls: 0,
      toolFailures: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    artifacts: [],
  }
}
