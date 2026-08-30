import { describe, expect, it } from 'vitest'
import { OpenAIModelProvider } from '../../src/runtime/models/openai-model-provider.js'
import { AnthropicModelProvider } from '../../src/runtime/models/anthropic-model-provider.js'
import { ResolvedSecret } from '../../src/security/resolved-secret.js'
import { measuredUsage } from '../../src/runtime/models/token-usage.js'

describe('测试套件：Token 计量完整性', () => {
  it('缺失、负数、小数和非有限值不能被认定为已计量', () => {
    for (const value of [undefined, null, -1, 1.5, Infinity, NaN]) {
      expect(measuredUsage(value, 1).status).toBe('unavailable')
      expect(measuredUsage(1, value).status).toBe('unavailable')
    }
    expect(measuredUsage(0, 0)).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('OpenAI 非流式与流式都要求输入输出计量齐全', async () => {
    for (const streaming of [false, true]) {
      for (const usage of [
        undefined,
        {},
        { prompt_tokens: 5 },
        { prompt_tokens: 5, completion_tokens: 2 },
      ]) {
        const provider = new OpenAIModelProvider({
          client: {
            chat: {
              completions: {
                create: async () => {
                  if (!streaming) {
                    return { choices: [{ message: { content: '完成' } }], usage }
                  }
                  return (async function* () {
                    yield { choices: [], usage }
                  })()
                },
              },
            },
          },
        })
        const request = { messages: [], tools: [] }
        const result = streaming
          ? await provider.stream(request, () => undefined)
          : await provider.complete(request)
        expect(result.usage.status).toBe(usage?.completion_tokens === 2 ? undefined : 'unavailable')
      }
    }
  })

  it('Anthropic 流式缺少任一计量阶段时标记不可用并支持末行无换行', async () => {
    for (const input of [true, false]) {
      for (const output of [true, false]) {
        const lines = [
          ...(input
            ? ['data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}']
            : []),
          ...(output ? ['data: {"type":"message_delta","usage":{"output_tokens":3}}'] : []),
        ]
        const provider = new AnthropicModelProvider({
          apiKey: new ResolvedSecret('test-only'),
          fetch: async () => new Response(lines.join('\n')),
        })
        const result = await provider.stream({ messages: [], tools: [] }, () => undefined)
        expect(result.usage.status).toBe(input && output ? undefined : 'unavailable')
      }
    }
  })
})
