import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ESTIMATE_COEFFICIENT,
  estimateTokens,
} from '../../packages/agent-runtime/src/context/token-estimate.js'
import { builtinModelProfile } from '../../packages/agent-runtime/src/models/builtin-providers.js'
import {
  computeUtilization,
  DEFAULT_CONTEXT_BUDGET_POLICY,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  FALLBACK_MAX_OUTPUT_TOKENS,
  resolveModelProfile,
} from '../../packages/agent-runtime/src/context/context-budget.js'
import type { ModelMessage } from '../../packages/agent-runtime/src/models/model-types.js'

describe('测试套件：estimateTokens', () => {
  it('空串返回 0 且标记估算', () => {
    expect(estimateTokens('')).toEqual({ tokens: 0, estimated: true })
  })

  it('按系数换算并向上取整', () => {
    expect(estimateTokens('abcdefgh')).toEqual({ tokens: 2, estimated: true })
    expect(estimateTokens('abcde')).toEqual({ tokens: 2, estimated: true })
    expect(estimateTokens('abcd')).toEqual({ tokens: 1, estimated: true })
  })

  it('多字节字符按码元计数', () => {
    // '中文中文中文' 为 6 个 UTF-16 码元：ceil(6/4)=2
    expect(estimateTokens('中文中文中文').tokens).toBe(2)
  })

  it('超长输入稳定', () => {
    expect(estimateTokens('a'.repeat(100_000)).tokens).toBe(25_000)
  })

  it('非法系数回退默认值', () => {
    for (const coefficient of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateTokens('abcdefgh', coefficient).tokens).toBe(2)
    }
    expect(DEFAULT_ESTIMATE_COEFFICIENT).toBe(4)
  })
})

describe('测试套件：resolveModelProfile', () => {
  it('未知模型回退保守默认并标记 estimated', () => {
    expect(resolveModelProfile(undefined)).toEqual({
      contextWindowTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
      supportsPromptCaching: false,
      estimated: true,
    })
  })

  it('部分档案补齐缺省字段', () => {
    expect(resolveModelProfile({ contextWindowTokens: 5_000 })).toEqual({
      contextWindowTokens: 5_000,
      maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
      supportsPromptCaching: false,
      estimated: false,
    })
  })

  it('完整档案原样保留', () => {
    expect(
      resolveModelProfile({
        contextWindowTokens: 200_000,
        maxOutputTokens: 64_000,
        supportsPromptCaching: true,
      }),
    ).toEqual({
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      supportsPromptCaching: true,
      estimated: false,
    })
  })
})

describe('测试套件：builtinModelProfile', () => {
  it('精确匹配内置模型', () => {
    expect(builtinModelProfile('claude-sonnet-4-20250514')?.contextWindowTokens).toBe(200_000)
    expect(builtinModelProfile('grok-4.6')?.contextWindowTokens).toBe(256_000)
  })

  it('模型 ID 或短别名与档案键互为前缀时按最长匹配', () => {
    expect(builtinModelProfile('claude-sonnet-4-20250514-rc1')?.contextWindowTokens).toBe(200_000)
    expect(builtinModelProfile('claude-sonnet-4')?.contextWindowTokens).toBe(200_000)
  })

  it('未登记模型返回 undefined', () => {
    expect(builtinModelProfile('totally-unknown-model')).toBeUndefined()
    expect(builtinModelProfile(undefined)).toBeUndefined()
  })
})

describe('测试套件：computeUtilization', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'a'.repeat(400) }]

  it('计入消息正文与输出预留', () => {
    const utilization = computeUtilization(messages, { contextWindowTokens: 10_000 })
    expect(utilization.estimatedInputTokens).toBe(100)
    expect(utilization.reserveOutputTokens).toBe(DEFAULT_CONTEXT_BUDGET_POLICY.reserveOutputTokens)
    expect(utilization.ratio).toBeCloseTo(
      (100 + DEFAULT_CONTEXT_BUDGET_POLICY.reserveOutputTokens) / 10_000,
    )
    expect(utilization.threshold).toBe(0.7)
    expect(utilization.estimated).toBe(true)
  })

  it('工具调用参数计入估算', () => {
    const withToolCall: ModelMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: {} }],
      },
    ]
    // name(9) + '{}'(2) = 11 字符 → ceil(11/4)=3 tokens
    expect(
      computeUtilization(withToolCall, { contextWindowTokens: 10_000 }).estimatedInputTokens,
    ).toBe(3)
  })

  it('占用可能超过 1 表示已超窗', () => {
    const utilization = computeUtilization(messages, { contextWindowTokens: 500 })
    expect(utilization.ratio).toBeGreaterThan(1)
  })

  it('自定义策略覆盖默认参数', () => {
    const utilization = computeUtilization(
      [{ role: 'user', content: 'abcdefgh' }],
      { contextWindowTokens: 1_000 },
      {
        utilizationThreshold: 0.5,
        estimateCoefficient: 2,
        reserveOutputTokens: 100,
      },
    )
    expect(utilization.estimatedInputTokens).toBe(4)
    expect(utilization.ratio).toBeCloseTo(104 / 1_000)
    expect(utilization.threshold).toBe(0.5)
  })
})
