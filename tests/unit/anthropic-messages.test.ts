import { describe, expect, it } from 'vitest'
import { ResolvedSecret } from '../../packages/core/src/security/resolved-secret.js'
import { AnthropicModelProvider } from '../../packages/agent-runtime/src/models/anthropic-model-provider.js'
import type {
  ModelMessage,
  ModelRequest,
} from '../../packages/agent-runtime/src/models/model-types.js'

function createProvider(captured: Array<Record<string, unknown>>) {
  return new AnthropicModelProvider({
    apiKey: new ResolvedSecret('test-only'),
    fetch: (async (url, init) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch,
  })
}

function completeRequest(messages: ModelMessage[]): ModelRequest {
  return { messages, tools: [] }
}

describe('测试套件：Anthropic 消息序列转换', () => {
  it('验证：纯工具调用的助手消息不产生空文本块', async () => {
    const captured: Array<Record<string, unknown>> = []
    const provider = createProvider(captured)
    await provider.complete(
      completeRequest([
        { role: 'system', content: 'sys' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'a' } }],
        },
        { role: 'tool', content: 'file body', toolCallId: 't1' },
      ]),
    )

    expect(captured).toHaveLength(1)
    const body = captured[0]!
    // M4：缓存开启时 system 为带 cache_control 的块形式。
    expect(body.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ])
    const messages = body.messages as Array<{ role: string; content: Array<{ type: string }> }>
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('assistant')
    expect(messages[0]?.content.some((block) => block.type === 'text')).toBe(false)
    expect(messages[0]?.content.filter((block) => block.type === 'tool_use')).toHaveLength(1)
    expect(messages[1]?.role).toBe('user')
    expect(messages[1]?.content[0]?.type).toBe('tool_result')
  })

  it('验证：工具结果后的用户消息合并为单条 user 消息且 tool_result 前置', async () => {
    const captured: Array<Record<string, unknown>> = []
    const provider = createProvider(captured)
    await provider.complete(
      completeRequest([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'a' } }],
        },
        { role: 'tool', content: 'file body', toolCallId: 't1' },
        { role: 'user', content: '请继续' },
      ]),
    )

    const messages = captured[0]!.messages as Array<{
      role: string
      content: Array<{ type: string; text?: string }>
    }>
    expect(messages).toHaveLength(2)
    expect(messages[1]?.role).toBe('user')
    expect(messages[1]?.content).toHaveLength(2)
    expect(messages[1]?.content[0]?.type).toBe('tool_result')
    expect(messages[1]?.content[1]?.type).toBe('text')
    expect(messages[1]?.content[1]?.text).toBe('请继续')
  })

  it('验证：交替角色保持不变', async () => {
    const captured: Array<Record<string, unknown>> = []
    const provider = createProvider(captured)
    await provider.complete(
      completeRequest([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' },
      ]),
    )

    const messages = captured[0]!.messages as Array<{ role: string }>
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
  })
})
