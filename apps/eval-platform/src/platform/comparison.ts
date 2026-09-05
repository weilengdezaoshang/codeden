import type { JobStatistics } from './statistics.js'

/**
 * M4 同条件对比：只读比较，不触发执行。
 * 规格（eval-repeat-experiments.md §6）：
 * - 可比前提：双方已完成、题目及版本/环境/判卷/次数一致、且都有完整有效判定（无 U/M）
 * - 被测变量（Agent/模型配置摘要）允许不同，其余条件不可暗中变化
 * - 只称"本次观测提高/下降"，不自动宣称显著改善或触发晋级
 */

export interface ComparisonSide {
  id: string
  status: string
  datasetId: string
  repetitions: number
  datasetDigest: string | null
  harnessType: string
  caseIds: readonly string[]
  statistics: JobStatistics | null
}

export interface ComparisonCaseRow {
  caseId: string
  baseline: { pass: number; planned: number; passRate: number | null }
  candidate: { pass: number; planned: number; passRate: number | null }
  /** 基线全通过 → 候选非全通过 = regressed；反向 = improved；否则 null */
  flipped: 'improved' | 'regressed' | null
}

export interface ComparisonResult {
  comparable: boolean
  reasons: string[]
  baseline: {
    id: string
    status: string
    validSuccessRate: number | null
    passShare: number | null
    coverage: number | null
    incomplete: boolean | null
  }
  candidate: ComparisonResult['baseline']
  /** 整体有效判定成功率观测差（百分点）；不可比时 null */
  validSuccessRateDeltaPoints: number | null
  cases: ComparisonCaseRow[]
}

function allPass(side: ComparisonSide, caseId: string): boolean | null {
  const stats = side.statistics?.cases.find((item) => item.caseId === caseId)
  if (!stats) {
    return null
  }
  const planned = stats.pass + stats.fail + stats.unknown + stats.pending
  return planned > 0 && stats.pass === planned
}

export function compareExperimentSides(
  baseline: ComparisonSide,
  candidate: ComparisonSide,
): ComparisonResult {
  const reasons: string[] = []
  if (baseline.status !== 'completed') {
    reasons.push(`基线任务未完成（当前 ${baseline.status}），证据不完整。`)
  }
  if (candidate.status !== 'completed') {
    reasons.push(`候选任务未完成（当前 ${candidate.status}），证据不完整。`)
  }
  if (baseline.datasetId !== candidate.datasetId) {
    reasons.push(`评测集不同：基线 ${baseline.datasetId}，候选 ${candidate.datasetId}。`)
  }
  if ((baseline.datasetDigest ?? '') !== (candidate.datasetDigest ?? '')) {
    reasons.push('题目或数据集版本不一致（冻结摘要不同）。')
  }
  if (baseline.harnessType !== candidate.harnessType) {
    reasons.push(`执行环境或判卷方式不一致：${baseline.harnessType} vs ${candidate.harnessType}。`)
  }
  if (baseline.repetitions !== candidate.repetitions) {
    reasons.push(
      `每题次数不一致：基线 ${baseline.repetitions} 次，候选 ${candidate.repetitions} 次。`,
    )
  }
  const baseIds = new Set(baseline.caseIds)
  const candIds = new Set(candidate.caseIds)
  const onlyBaseline = [...baseIds].filter((id) => !candIds.has(id))
  const onlyCandidate = [...candIds].filter((id) => !baseIds.has(id))
  if (onlyBaseline.length > 0 || onlyCandidate.length > 0) {
    reasons.push('题目集合不一致。')
  }
  for (const [role, side] of [
    ['基线', baseline],
    ['候选', candidate],
  ] as const) {
    if (side.statistics && (side.statistics.unknown > 0 || side.statistics.pending > 0)) {
      reasons.push(
        `${role}存在未判定 ${side.statistics.unknown}、未完成 ${side.statistics.pending}，证据不完整。`,
      )
    }
    if (!side.statistics) {
      reasons.push(`${role}缺少计划口径统计。`)
    }
  }

  const comparable = reasons.length === 0
  const baseRate = baseline.statistics?.validSuccessRate ?? null
  const candRate = candidate.statistics?.validSuccessRate ?? null
  const cases: ComparisonCaseRow[] = []
  if (comparable) {
    for (const caseId of [...baseIds].sort()) {
      const bStats = baseline.statistics?.cases.find((item) => item.caseId === caseId)
      const cStats = candidate.statistics?.cases.find((item) => item.caseId === caseId)
      const rate = (stats: typeof bStats) => {
        if (!stats) {
          return null
        }
        const planned = stats.pass + stats.fail + stats.unknown + stats.pending
        return planned > 0 ? stats.pass / planned : null
      }
      const baseAllPass = allPass(baseline, caseId)
      const candAllPass = allPass(candidate, caseId)
      cases.push({
        caseId,
        baseline: {
          pass: bStats?.pass ?? 0,
          planned:
            (bStats?.pass ?? 0) +
            (bStats?.fail ?? 0) +
            (bStats?.unknown ?? 0) +
            (bStats?.pending ?? 0),
          passRate: rate(bStats),
        },
        candidate: {
          pass: cStats?.pass ?? 0,
          planned:
            (cStats?.pass ?? 0) +
            (cStats?.fail ?? 0) +
            (cStats?.unknown ?? 0) +
            (cStats?.pending ?? 0),
          passRate: rate(cStats),
        },
        flipped:
          baseAllPass === true && candAllPass === false
            ? 'regressed'
            : baseAllPass === false && candAllPass === true
              ? 'improved'
              : null,
      })
    }
  }

  return {
    comparable,
    reasons,
    baseline: {
      id: baseline.id,
      status: baseline.status,
      validSuccessRate: baseRate,
      passShare: baseline.statistics?.passShare ?? null,
      coverage: baseline.statistics?.coverage ?? null,
      incomplete: baseline.statistics?.incomplete ?? null,
    },
    candidate: {
      id: candidate.id,
      status: candidate.status,
      validSuccessRate: candRate,
      passShare: candidate.statistics?.passShare ?? null,
      coverage: candidate.statistics?.coverage ?? null,
      incomplete: candidate.statistics?.incomplete ?? null,
    },
    validSuccessRateDeltaPoints:
      comparable && baseRate !== null && candRate !== null ? (candRate - baseRate) * 100 : null,
    cases,
  }
}
