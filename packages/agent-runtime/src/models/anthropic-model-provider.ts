import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { isTokenCount, measuredUsage } from './token-usage.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { ResolvedSecret } from '@codeden/core/security/resolved-secret.js'
import type { ModelProvider } from './model-provider.js'
import type { ModelMessage, ModelRequest, ModelResponse, ModelToolCall } from './model-types.js'

export interface AnthropicModelProviderOptions {
  name?: string
  model?: string
  apiKey: ResolvedSecret
  baseURL?: string
  fetch?: typeof globalThis.fetch
}

export class AnthropicModelProvider implements ModelProvider {
  readonly name: string
  private readonly model: string

  get descriptor() {
    return { model: this.model, protocol: 'anthropic' }
  }
  private readonly apiKey: ResolvedSecret
  private readonly baseURL: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(options: AnthropicModelProviderOptions) {
    this.name = options.name ?? 'anthropic'
    this.model = options.model ?? 'claude-sonnet-4-20250514'
    this.apiKey = options.apiKey
    this.baseURL = (options.baseURL ?? 'https://api.anthropic.com').replace(/\/$/u, '')
    this.fetchFn = options.fetch ?? globalThis.fetch
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.request(request, false)
    return parseResponse(await response.json())
  }

  async stream(
    request: ModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
  ): Promise<ModelResponse> {
    const response = await this.request(request, true)
    if (!response.body) {
      throw providerError('Anthropic response did not include a body')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let stopReason: string | undefined
    let inputTokens = 0
    let outputTokens = 0
    let inputMeasured = false
    let outputMeasured = false
    const tools = new Map<number, { id: string; name: string; input: string }>()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) {
          break
        }
        buffer += decoder.decode(chunk.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) {
            continue
          }
          const event = parseJson(line.slice(5).trim())
          if (!event || typeof event !== 'object') {
            continue
          }
          const item = event as Record<string, unknown>
          const delta = isRecord(item.delta) ? item.delta : undefined
          if (
            item.type === 'content_block_start' &&
            isRecord(item.content_block) &&
            item.content_block.type === 'tool_use'
          ) {
            tools.set(Number(item.index ?? tools.size), {
              id:
                typeof item.content_block.id === 'string'
                  ? item.content_block.id
                  : `tool_${tools.size}`,
              name: typeof item.content_block.name === 'string' ? item.content_block.name : '',
              input: '',
            })
          }
          if (
            item.type === 'content_block_delta' &&
            delta?.type === 'text_delta' &&
            typeof delta.text === 'string'
          ) {
            text += delta.text
            await onTextDelta(delta.text)
          }
          if (
            item.type === 'content_block_delta' &&
            delta?.type === 'input_json_delta' &&
            typeof delta.partial_json === 'string'
          ) {
            const current = tools.get(Number(item.index ?? 0))
            if (current) {
              current.input += delta.partial_json
            }
          }
          if (item.type === 'message_delta' && typeof delta?.stop_reason === 'string') {
            stopReason = delta.stop_reason
          }
          if (
            item.type === 'message_start' &&
            isRecord(item.message) &&
            isRecord(item.message.usage)
          ) {
            inputMeasured = isTokenCount(item.message.usage.input_tokens)
            inputTokens = numberOrZero(item.message.usage.input_tokens)
          }
          if (item.type === 'message_delta' && isRecord(item.usage)) {
            outputMeasured = isTokenCount(item.usage.output_tokens)
            outputTokens = numberOrZero(item.usage.output_tokens)
          }
        }
      }
      // Some SSE servers omit the trailing newline on the final event.
      if (buffer.trim()) {
        const event = buffer.startsWith('data:') ? parseJson(buffer.slice(5).trim()) : undefined
        if (isRecord(event)) {
          const item = event
          const delta = isRecord(item.delta) ? item.delta : undefined
          if (
            item.type === 'content_block_delta' &&
            delta?.type === 'text_delta' &&
            typeof delta.text === 'string'
          ) {
            text += delta.text
            await onTextDelta(delta.text)
          }
          if (item.type === 'message_delta' && typeof delta?.stop_reason === 'string') {
            stopReason = delta.stop_reason
          }
          if (item.type === 'message_delta' && isRecord(item.usage)) {
            outputMeasured = isTokenCount(item.usage.output_tokens)
            outputTokens = numberOrZero(item.usage.output_tokens)
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
    return {
      text,
      toolCalls: [...tools.values()].map(parseStreamTool),
      stopReason: mapStopReason(stopReason, tools.size > 0),
      usage: {
        inputTokens,
        outputTokens,
        ...(!(inputMeasured && outputMeasured) ? { status: 'unavailable' as const } : {}),
      },
    }
  }

  private async request(request: ModelRequest, stream: boolean): Promise<Response> {
    if (request.signal?.aborted) {
      throw abortedError()
    }
    const messages = request.messages.filter((message) => message.role !== 'system')
    const system = request.messages.find((message) => message.role === 'system')?.content
    const body = {
      model: this.model,
      max_tokens: request.reasoningEffort ? 16_384 : 8_192,
      ...(request.reasoningEffort
        ? { thinking: { type: 'enabled', budget_tokens: reasoningBudget(request.reasoningEffort) } }
        : {}),
      ...(system ? { system } : {}),
      messages: messages.map(toAnthropicMessage),
      tools:
        request.tools.length > 0
          ? request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            }))
          : undefined,
      stream,
    }
    let response: Response
    try {
      response = await this.fetchFn(`${this.baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey.exposeForTransport(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      })
    } catch (error) {
      if (request.signal?.aborted) {
        throw abortedError()
      }
      throw providerError(error instanceof Error ? error.message : 'Anthropic request failed')
    }
    if (!response.ok) {
      throw providerError(`Anthropic request failed (${response.status})`, response.status)
    }
    return response
  }
}

function reasoningBudget(effort: 'low' | 'medium' | 'high'): number {
  return effort === 'low' ? 1_024 : effort === 'medium' ? 4_096 : 8_192
}

function toAnthropicMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }],
    }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        { type: 'text', text: message.content },
        ...message.toolCalls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      ],
    }
  }
  return { role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }
}

function parseResponse(response: unknown): ModelResponse {
  if (!isRecord(response)) {
    throw providerError('Anthropic response was not an object')
  }
  const content = Array.isArray(response.content) ? response.content : []
  const text = content
    .filter(isRecord)
    .filter((item) => item.type === 'text')
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .join('')
  const toolCalls = content
    .filter(isRecord)
    .filter(
      (item) =>
        item.type === 'tool_use' && typeof item.id === 'string' && typeof item.name === 'string',
    )
    .map((item) => ({
      id: item.id as string,
      name: item.name as string,
      arguments: item.input ?? {},
    }))
  const usage = isRecord(response.usage) ? response.usage : {}
  return {
    text,
    toolCalls,
    stopReason: mapStopReason(
      typeof response.stop_reason === 'string' ? response.stop_reason : undefined,
      toolCalls.length > 0,
    ),
    usage: measuredUsage(usage.input_tokens, usage.output_tokens),
  }
}

function parseStreamTool(value: { id: string; name: string; input: string }): ModelToolCall {
  let arguments_: unknown = {}
  try {
    arguments_ = value.input ? JSON.parse(value.input) : {}
  } catch {
    throw providerError(`Invalid Anthropic tool input: ${value.name}`)
  }
  return { id: value.id, name: value.name, arguments: arguments_ }
}

function mapStopReason(reason: string | undefined, hasTools: boolean): ModelResponse['stopReason'] {
  if (reason === 'tool_use' || hasTools) {
    return 'tool_use'
  }
  if (reason === 'max_tokens') {
    return 'max_tokens'
  }
  if (reason === 'end_turn' || reason === 'stop_sequence') {
    return 'end_turn'
  }
  return 'unknown'
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function numberOrZero(value: unknown): number {
  return isTokenCount(value) ? value : 0
}
function providerError(message: string, status?: number): CodeDenError {
  return new CodeDenError({
    code: status === 401 ? ErrorCodes.MODEL_AUTHENTICATION_FAILED : ErrorCodes.MODEL_REQUEST_FAILED,
    category: 'model',
    message,
    retryable: status === 429 || (status !== undefined && status >= 500),
  })
}
function abortedError(): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.AGENT_TIMEOUT,
    category: 'timeout',
    message: 'Anthropic request aborted',
    retryable: false,
  })
}
