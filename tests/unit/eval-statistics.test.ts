import { describe, expect, it } from 'vitest'
import {
  deriveCaseStatistics,
  deriveStatistics,
  wilsonInterval,
} from '../../apps/eval-platform/src/platform/statistics.js'

describe('M2 · 统计口径', () => {
  it('规格示例：P=60 F=20 U=10 M=10 → 60/100、60/80、80/100，并标记不完整', () => {
    const stats = deriveStatistics({ pass: 60, fail: 20, unknown: 10, pending: 10 })
    expect(stats.planned).toBe(100)
    expect(stats.processed).toBe(90)
    expect(stats.validVerdicts).toBe(80)
    expect(stats.passShare).toBeCloseTo(0.6)
    expect(stats.validSuccessRate).toBeCloseTo(0.75)
    expect(stats.coverage).toBeCloseTo(0.8)
    expect(stats.incomplete).toBe(true)
    expect(stats.statisticsVersion).toBe('1')
  })

  it('恒等式：N = P + F + U + M 对任意计数成立', () => {
    const stats = deriveStatistics({ pass: 3, fail: 1, unknown: 2, pending: 5 })
    expect(stats.planned).toBe(3 + 1 + 2 + 5)
  })

  it('分母为 0：有效判定成功率为 null，不产生假 0%', () => {
    const stats = deriveStatistics({ pass: 0, fail: 0, unknown: 0, pending: 7 })
    // N=7>0：P/N 与 (P+F)/N 是合法的 0；但有效判定分母 P+F=0 → null（界面显示"暂无有效判定"）
    expect(stats.passShare).toBe(0)
    expect(stats.coverage).toBe(0)
    expect(stats.validSuccessRate).toBeNull()
    expect(stats.incomplete).toBe(true)
  })

  it('N=0：三个比率均为 null', () => {
    const stats = deriveStatistics({ pass: 0, fail: 0, unknown: 0, pending: 0 })
    expect(stats.passShare).toBeNull()
    expect(stats.validSuccessRate).toBeNull()
    expect(stats.coverage).toBeNull()
  })

  it('全部完成且无失败：incomplete 为 false', () => {
    const stats = deriveStatistics({ pass: 4, fail: 0, unknown: 0, pending: 0 })
    expect(stats.incomplete).toBe(false)
    expect(stats.validSuccessRate).toBe(1)
  })

  it('Wilson 5/5 通过：区间约 56.6%–100%，不宣称真实成功率必为 100%', () => {
    const interval = wilsonInterval(5, 5)
    expect(interval).not.toBeNull()
    expect(interval!.lower).toBeGreaterThanOrEqual(0.565)
    expect(interval!.lower).toBeLessThanOrEqual(0.567)
    expect(interval!.upper).toBe(1)
  })

  it('Wilson 0/5：下界 0，上界约 43.4%，有效判定仍存在', () => {
    const interval = wilsonInterval(0, 5)
    expect(interval!.lower).toBe(0)
    expect(interval!.upper).toBeLessThanOrEqual(0.435)
    expect(interval!.upper).toBeGreaterThanOrEqual(0.433)
  })

  it('Wilson n=0：不计算', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
  })
})

describe('M2 · 每题统计', () => {
  it('5 次全通过 → 全通过 + Wilson 区间', () => {
    const stats = deriveCaseStatistics('case-a', {
      pass: 5,
      fail: 0,
      unknown: 0,
      pending: 0,
      repetitionCount: 5,
    })
    expect(stats.label).toBe('全通过')
    expect(stats.wilson).not.toBeNull()
  })

  it('有未执行 → 结果不完整，不显示稳定标签', () => {
    const stats = deriveCaseStatistics('case-b', {
      pass: 2,
      fail: 1,
      unknown: 0,
      pending: 2,
      repetitionCount: 5,
    })
    expect(stats.label).toBe('结果不完整')
  })

  it('2 通过 3 失败 → 波动；全失败 → 全不通过', () => {
    expect(
      deriveCaseStatistics('c', { pass: 2, fail: 3, unknown: 0, pending: 0, repetitionCount: 5 })
        .label,
    ).toBe('结果波动')
    expect(
      deriveCaseStatistics('c', { pass: 0, fail: 5, unknown: 0, pending: 0, repetitionCount: 5 })
        .label,
    ).toBe('全不通过')
  })

  it('单次冒烟：标签为单次结果，不展示 Wilson 稳定性区间', () => {
    const stats = deriveCaseStatistics('c', {
      pass: 1,
      fail: 0,
      unknown: 0,
      pending: 0,
      repetitionCount: 1,
    })
    expect(stats.label).toBe('单次结果')
    expect(stats.wilson).toBeNull()
  })
})
