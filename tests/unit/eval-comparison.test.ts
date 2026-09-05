import { describe, expect, it } from 'vitest'
import {
  compareExperimentSides,
  type ComparisonSide,
} from '../../apps/eval-platform/src/platform/comparison.js'
import type { JobStatistics } from '../../apps/eval-platform/src/platform/statistics.js'

function side(overrides: Partial<ComparisonSide> & { id: string }): ComparisonSide {
  return {
    status: 'completed',
    datasetId: 'all',
    repetitions: 3,
    datasetDigest: 'a'.repeat(64),
    harnessType: 'native',
    caseIds: ['case-a', 'case-b'],
    statistics: stats(),
    ...overrides,
  }
}

function stats(overrides: Partial<JobStatistics> = {}): JobStatistics {
  return {
    statisticsVersion: '1',
    planned: 6,
    pass: 6,
    fail: 0,
    unknown: 0,
    pending: 0,
    processed: 6,
    validVerdicts: 6,
    passShare: 1,
    validSuccessRate: 1,
    coverage: 1,
    incomplete: false,
    cases: [
      {
        caseId: 'case-a',
        repetitionCount: 3,
        pass: 3,
        fail: 0,
        unknown: 0,
        pending: 0,
        label: '全通过',
        wilson: null,
      },
      {
        caseId: 'case-b',
        repetitionCount: 3,
        pass: 3,
        fail: 0,
        unknown: 0,
        pending: 0,
        label: '全通过',
        wilson: null,
      },
    ],
    ...overrides,
  }
}

describe('M4 · 同条件对比', () => {
  it('同条件两场 → 可比，整体差异 0，无回归题', () => {
    const result = compareExperimentSides(side({ id: 'base' }), side({ id: 'cand' }))
    expect(result.comparable).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.validSuccessRateDeltaPoints).toBe(0)
    expect(result.cases.every((row) => row.flipped === null)).toBe(true)
  })

  it('次数不一致 → 不可比并给出原因', () => {
    const result = compareExperimentSides(
      side({ id: 'base' }),
      side({ id: 'cand', repetitions: 5 }),
    )
    expect(result.comparable).toBe(false)
    expect(result.reasons.some((reason) => reason.includes('每题次数不一致'))).toBe(true)
    expect(result.validSuccessRateDeltaPoints).toBeNull()
  })

  it('数据集摘要不同 → 不可比', () => {
    const result = compareExperimentSides(
      side({ id: 'base' }),
      side({ id: 'cand', datasetDigest: 'b'.repeat(64) }),
    )
    expect(result.comparable).toBe(false)
    expect(result.reasons.some((reason) => reason.includes('题目或数据集版本不一致'))).toBe(true)
  })

  it('存在未判定 → 证据不完整，不可比', () => {
    const candidateStats = stats({
      pass: 5,
      fail: 0,
      unknown: 1,
      pending: 0,
      validSuccessRate: 1,
      incomplete: true,
      cases: [
        {
          caseId: 'case-a',
          repetitionCount: 3,
          pass: 3,
          fail: 0,
          unknown: 0,
          pending: 0,
          label: '全通过',
          wilson: null,
        },
        {
          caseId: 'case-b',
          repetitionCount: 3,
          pass: 2,
          fail: 0,
          unknown: 1,
          pending: 0,
          label: '结果不完整',
          wilson: null,
        },
      ],
    })
    const result = compareExperimentSides(
      side({ id: 'base' }),
      side({ id: 'cand', statistics: candidateStats }),
    )
    expect(result.comparable).toBe(false)
    expect(result.reasons.some((reason) => reason.includes('证据不完整'))).toBe(true)
  })

  it('基线未完成 → 不可比', () => {
    const result = compareExperimentSides(
      side({ id: 'base', status: 'running' }),
      side({ id: 'cand' }),
    )
    expect(result.comparable).toBe(false)
    expect(result.reasons.some((reason) => reason.includes('基线任务未完成'))).toBe(true)
  })

  it('基线部分失败 → 候选全通过 = improved；反向 = regressed', () => {
    const baseStats = stats({
      pass: 3,
      fail: 3,
      validSuccessRate: 0.5,
      passShare: 0.5,
      coverage: 1,
      cases: [
        {
          caseId: 'case-a',
          repetitionCount: 3,
          pass: 3,
          fail: 0,
          unknown: 0,
          pending: 0,
          label: '全通过',
          wilson: null,
        },
        {
          caseId: 'case-b',
          repetitionCount: 3,
          pass: 0,
          fail: 3,
          unknown: 0,
          pending: 0,
          label: '全不通过',
          wilson: null,
        },
      ],
    })
    const improved = compareExperimentSides(
      side({ id: 'base', statistics: baseStats }),
      side({ id: 'cand' }),
    )
    expect(improved.comparable).toBe(true)
    expect(improved.validSuccessRateDeltaPoints).toBeCloseTo(50)
    const caseB = improved.cases.find((row) => row.caseId === 'case-b')
    expect(caseB?.flipped).toBe('improved')
    const regressed = compareExperimentSides(
      side({ id: 'base' }),
      side({ id: 'cand', statistics: baseStats }),
    )
    const caseBRegressed = regressed.cases.find((row) => row.caseId === 'case-b')
    expect(caseBRegressed?.flipped).toBe('regressed')
  })
})
