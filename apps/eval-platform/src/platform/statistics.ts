/**
 * M2 统计口径：全部由计划行计数（P/F/U/M）推导，单一出口。
 * 规格（eval-repeat-experiments.md §5）：
 * - N = P + F + U + M；已处理 = P + F + U；有效判定 = P + F
 * - 计划通过占比 = P/N；有效判定成功率 = P/(P+F)；覆盖率 = (P+F)/N
 * - 分母为 0 时比率为 null（界面显示"暂无有效判定"，不显示 0% 或 100%）
 * - U>0 或 M>0 → incomplete（结果不完整，不用于确定性版本结论）
 */

export const STATISTICS_VERSION = '1'

export interface PlanCounts {
  pass: number
  fail: number
  unknown: number
  pending: number
}

export interface Statistics {
  statisticsVersion: string
  planned: number
  pass: number
  fail: number
  unknown: number
  pending: number
  processed: number
  validVerdicts: number
  /** 计划通过占比 P/N；N=0 → null */
  passShare: number | null
  /** 有效判定成功率 P/(P+F)；分母 0 → null */
  validSuccessRate: number | null
  /** 判定覆盖率 (P+F)/N；N=0 → null */
  coverage: number | null
  /** U>0 或 M>0：结果不完整，不用于确定性版本结论 */
  incomplete: boolean
}

/** 任务级统计（含每题 Wilson），即 GET /api/jobs/:id 的 statistics 字段。 */
export interface JobStatistics extends Statistics {
  cases: CaseStatistics[]
}

export function deriveStatistics(counts: PlanCounts): Statistics {
  const planned = counts.pass + counts.fail + counts.unknown + counts.pending
  const processed = counts.pass + counts.fail + counts.unknown
  const validVerdicts = counts.pass + counts.fail
  return {
    statisticsVersion: STATISTICS_VERSION,
    planned,
    pass: counts.pass,
    fail: counts.fail,
    unknown: counts.unknown,
    pending: counts.pending,
    processed,
    validVerdicts,
    passShare: planned > 0 ? counts.pass / planned : null,
    validSuccessRate: validVerdicts > 0 ? counts.pass / validVerdicts : null,
    coverage: planned > 0 ? validVerdicts / planned : null,
    incomplete: counts.unknown > 0 || counts.pending > 0,
  }
}

export interface WilsonInterval {
  /** 区间中心 p̂ */
  center: number
  lower: number
  upper: number
  confidence: 0.95
}

/** 95% Wilson 区间；n = P+F，n=0 不计算（返回 null）。R=1 不展示稳定性区间。 */
export function wilsonInterval(pass: number, validTotal: number, z = 1.96): WilsonInterval | null {
  const n = validTotal
  if (!Number.isFinite(n) || n <= 0) {
    return null
  }
  const p = pass / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return {
    center,
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    confidence: 0.95,
  }
}

/** 单题统计：计数 + 分类标签 + 95% Wilson 区间（有效判定 n=0 时区间为 null）。 */
export interface CaseStatistics {
  caseId: string
  repetitionCount: number
  pass: number
  fail: number
  unknown: number
  pending: number
  /** 全通过 | 全不通过 | 结果波动 | 结果不完整 | 排队中 | 单次结果 */
  label: string
  wilson: WilsonInterval | null
}

export function deriveCaseStatistics(
  caseId: string,
  counts: PlanCounts & { repetitionCount: number },
): CaseStatistics {
  const planned = counts.pass + counts.fail + counts.unknown + counts.pending
  let label: string
  if (counts.repetitionCount === 1) {
    label = '单次结果'
  } else if (planned === 0 || counts.pending === planned) {
    label = '排队中'
  } else if (counts.unknown > 0 || counts.pending > 0) {
    label = '结果不完整'
  } else if (counts.pass === planned) {
    label = '全通过'
  } else if (counts.fail === planned) {
    label = '全不通过'
  } else {
    label = '结果波动'
  }
  return {
    caseId,
    repetitionCount: counts.repetitionCount,
    pass: counts.pass,
    fail: counts.fail,
    unknown: counts.unknown,
    pending: counts.pending,
    label,
    wilson:
      counts.repetitionCount > 1 ? wilsonInterval(counts.pass, counts.pass + counts.fail) : null,
  }
}
