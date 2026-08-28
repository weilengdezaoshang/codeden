import { describe, expect, it } from 'vitest'
import {
  MockModelProvider,
  finalText,
  toolCall,
} from '../../src/runtime/models/mock-model-provider.js'
import {
  OpenAIModelProvider,
  type OpenAIChatClient,
} from '../../src/runtime/models/openai-model-provider.js'
import type { ModelProvider } from '../../src/runtime/models/model-provider.js'
import { AnthropicModelProvider } from '../../src/runtime/models/anthropic-model-provider.js'
import { ResolvedSecret } from '../../src/security/resolved-secret.js'

function runContract(name: string, create: () => ModelProvider) {
  describe(`${name} ModelProvider contract`, () => {
    it('normalizes a text response', async () => {
      const response = await create().complete({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      })
      expect(typeof response.text).toBe('string')
      expect(response.toolCalls).toEqual([])
      expect(response.stopReason).toBe('end_turn')
      expect(response.usage.inputTokens).toBeGreaterThanOrEqual(0)
      expect(response.usage.outputTokens).toBeGreaterThanOrEqual(0)
    })
  })
}

runContract('mock text', () => new MockModelProvider([finalText('hello')]))

describe('mock ModelProvider tool contract', () => {
  it('normalizes a tool call', async () => {
    const response = await new MockModelProvider([toolCall('read_file', { path: 'a' })]).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    expect(response.toolCalls[0]).toMatchObject({ name: 'read_file', arguments: { path: 'a' } })
    expect(response.stopReason).toBe('tool_use')
  })
})

describe('OpenAIModelProvider contract', () => {
  it('normalizes text, tool calls, usage and errors without leaking SDK types', async () => {
    const client: OpenAIChatClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: '',
                    tool_calls: [
                      {
                        id: 'call_1',
                        function: { name: 'read_file', arguments: '{"path":"package.json"}' },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 11, completion_tokens: 7 },
            }
          },
        },
      },
    }
    const provider = new OpenAIModelProvider({ client })
    const response = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    expect(response.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'read_file',
      arguments: { path: 'package.json' },
    })
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
    expect(response.stopReason).toBe('tool_use')
    expect(JSON.stringify(response)).not.toContain('prompt_tokens')

    const failing = new OpenAIModelProvider({
      client: {
        chat: {
          completions: {
            async create() {
              const error = Object.assign(new Error('rate limited'), { status: 429 })
              throw error
            },
          },
        },
      },
    })
    await expect(failing.complete({ messages: [], tools: [] })).rejects.toMatchObject({
      code: 'MODEL_REQUEST_FAILED',
      retryable: true,
    })
  })

  it('maps abort errors to AGENT_TIMEOUT', async () => {
    const provider = new OpenAIModelProvider({
      client: {
        chat: {
          completions: {
            async create() {
              throw Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })
            },
          },
        },
      },
    })
    await expect(provider.complete({ messages: [], tools: [] })).rejects.toMatchObject({
      code: 'AGENT_TIMEOUT',
    })

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(
      provider.complete({ messages: [], tools: [], signal: alreadyAborted.signal }),
    ).rejects.toMatchObject({ code: 'AGENT_TIMEOUT' })
  })
})

describe('AnthropicModelProvider contract', () => {
  it('验证：解析文本、工具调用和用量字段', async () => {
    let requestBody = ''
    const provider = new AnthropicModelProvider({
      apiKey: new ResolvedSecret('test-key'),
      fetch: async (_input, init) => {
        requestBody = String(init?.body)
        return new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: '完成' },
              { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 4, output_tokens: 3 },
          }),
          { status: 200 },
        )
      },
    })
    const response = await provider.complete({
      messages: [
        { role: 'system', content: '规则' },
        { role: 'user', content: '读取' },
      ],
      tools: [],
    })
    expect(response.text).toBe('完成')
    expect(response.toolCalls[0]).toMatchObject({ name: 'read_file', arguments: { path: 'a.txt' } })
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 3 })
    expect(JSON.parse(requestBody)).toMatchObject({
      system: '规则',
      messages: [{ role: 'user', content: '读取' }],
    })
  })

  it('验证：解析没有尾随换行的流式事件', async () => {
    const provider = new AnthropicModelProvider({
      apiKey: new ResolvedSecret('test-key'),
      fetch: async () =>
        new Response(
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"尾部"}}',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    const deltas: string[] = []
    const response = await provider.stream(
      { messages: [{ role: 'user', content: '继续' }], tools: [] },
      (delta) => {
        deltas.push(delta)
      },
    )
    expect(deltas).toEqual(['尾部'])
    expect(response.text).toBe('尾部')
  })
})
