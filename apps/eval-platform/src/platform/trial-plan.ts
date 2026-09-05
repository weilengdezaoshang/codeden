import type { TrialResult } from '@codeden/eval-engine/domain/trial-result.js'

/** 统计与失败归因口径版本；随字段语义演进递增。 */
export const STATISTICS_VERSION = '1'
export const FAILURE_TAXONOMY_VERSION = '1'

/** 失败归因枚举 v1：稳定枚举供定位视图筛选，语义变更需升版本。 */
export const ERROR_CATEGORIES = [
  'env_failure',
  'model_error',
  'tool_misuse',
  'assertion_failed',
  'timeout',
  'submission_invalid',
  'unknown',
] as const
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]

export type TrialLifecycle =
  'queued' | 'preparing' | 'running' | 'grading' | 'completed' | 'cancelled' | 'interrupted'

export type TrialVerdict = 'pass' | 'fail' | 'unknown'

/** 平台计划口径的 Trial 身份：题目基础 ID + 重复序号（1 起）。 */
export interface PlannedTrial {
  caseId: string
  repetitionIndex: number
  position: number
}

/** 拆解重复评测的题目编号：`case#3` → 基础 `case` + 第 3 次；无后缀即第 1 次。 */
export function parsePlannedCaseId(caseId: string): {
  baseId: string
  repetitionIndex: number
} {
  const match = /^(.*)#([1-9][0-9]*)$/u.exec(caseId)
  if (!match) {
    return { baseId: caseId, repetitionIndex: 1 }
  }
  return { baseId: match[1] ?? caseId, repetitionIndex: Number(match[2]) }
}

/** 计划身份还原为快照中的题目 ID：第 1 次无后缀，其余 `caseId#N`。 */
export function plannedCaseSnapshotId(caseId: string, repetitionIndex: number): string {
  return repetitionIndex === 1 ? caseId : `${caseId}#${repetitionIndex}`
}

/** 由重复展开后的题目清单生成计划行；顺序即创建时冻结的执行顺序。 */
export function buildTrialPlans(caseIds: readonly string[]): PlannedTrial[] {
  return caseIds.map((rawCaseId, index) => {
    const { baseId, repetitionIndex } = parsePlannedCaseId(rawCaseId)
    return { caseId: baseId, repetitionIndex, position: index + 1 }
  })
}

export interface TrialOutcome {
  verdict: TrialVerdict
  errorCategory: ErrorCategory
  failureStage: 'prepare' | 'agent' | 'verify' | 'grade'
  failureDetail: string | null
}

function failureCategoryOf(result: TrialResult, fallback: ErrorCategory): ErrorCategory {
  const raw = result.failure?.category
  const mapping: Record<string, ErrorCategory> = {
    infrastructure: 'env_failure',
    timeout: 'timeout',
    budget: 'timeout',
    submission: 'submission_invalid',
    verification: 'assertion_failed',
    agent: 'model_error',
  }
  if (raw && raw in mapping) {
    return mapping[raw] ?? fallback
  }
  return fallback
}

function detailOf(result: TrialResult): string | null {
  const message = result.failure?.message
  if (!message) {
    return null
  }
  return message.length > 2_000 ? `…${message.slice(-2_000)}` : message
}

/**
 * 服务端唯一口径：由 TrialResult 推导 verdict 与失败归因。
 * 只有有效验收产生 pass/fail；环境故障、Agent 异常、判卷故障、证据不足一律 unknown，未完成由 lifecycle 表达（verdict NULL）。
 */
export function deriveTrialOutcome(result: TrialResult): TrialOutcome {
  if (result.infrastructure.status !== 'ok') {
    return {
      verdict: 'unknown',
      errorCategory: 'env_failure',
      failureStage: 'prepare',
      failureDetail: detailOf(result),
    }
  }
  if (result.execution.status === 'agent_error') {
    return {
      verdict: 'unknown',
      errorCategory: failureCategoryOf(result, 'model_error'),
      failureStage: 'agent',
      failureDetail: detailOf(result),
    }
  }
  if (result.execution.status === 'timeout' && result.verification.status !== 'failed') {
    return {
      verdict: 'unknown',
      errorCategory: 'timeout',
      failureStage: 'agent',
      failureDetail: detailOf(result),
    }
  }
  if (result.verification.status === 'error') {
    return {
      verdict: 'unknown',
      errorCategory: 'unknown',
      failureStage: 'grade',
      failureDetail: detailOf(result),
    }
  }
  if (result.verification.status === 'passed') {
    return { verdict: 'pass', errorCategory: 'unknown', failureStage: 'grade', failureDetail: null }
  }
  return {
    verdict: 'fail',
    errorCategory: failureCategoryOf(result, 'assertion_failed'),
    failureStage: 'verify',
    failureDetail: detailOf(result),
  }
}
