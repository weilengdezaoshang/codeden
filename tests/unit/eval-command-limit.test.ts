import { describe, expect, it } from 'vitest'
import { limitCases } from '../../apps/eval-platform/src/cli/eval-command.js'

describe('测试套件：评测用例筛选', () => {
  it('验证：按限制数量截取评测用例并保留顺序', () => {
    expect(limitCases(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
    expect(limitCases(['a'], 10)).toEqual(['a'])
  })

  it('验证：拒绝零值、负数和小数限制', () => {
    expect(() => limitCases(['a'], 0)).toThrow('Invalid --limit: 0')
    expect(() => limitCases(['a'], -1)).toThrow('Invalid --limit: -1')
    expect(() => limitCases(['a'], 1.5)).toThrow('Invalid --limit: 1.5')
  })
})
