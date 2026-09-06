import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { isTokenCount, measuredUsage } from './token-usage.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { ResolvedSecret } from '@codeden/core/security/resolved-secret.js'
import { builtinModelProfile } from './builtin-providers.js'
import type { ModelProvider } from './model-provider.js'
import type { ModelMessage, ModelRequest, ModelResponse, ModelToolCall } from './model-types.js'

export interface AnthropicModelProviderOptions {
  name?: string
  model?: string
  apiKey: ResolvedSecret
  baseURL?: string
  fetch?: typeof globalThis.fetch
  /** 稳定前缀提示缓存（cache_control）；默认开启，仅对档案声明支持缓存的模型生效。 */
  promptCaching?: boolean
  /** 覆盖模型档案的输出上限；未提供时按 builtinModelProfile 解析。 */
  maxOutputTokens?: number
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
  private readonly maxOutputTokens: number | undefined
  private readonly promptCaching: boolean

  constructor(options: AnthropicModelProviderOptions) {
    this.name = options.name ?? 'anthropic'
    this.model = options.model ?? 'claude-sonnet-4-20250514'
    this.apiKey = options.apiKey
    this.baseURL = (options.baseURL ?? 'https://api.anthropic.com').replace(/\/$/u, '')
    this.fetchFn = options.fetch ?? globalThis.fetch
    // 缓存仅在模型档案声明支持时生效（M4）；未知模型默认关闭，避免不支持的请求体。
    const profile = builtinModelProfile(this.model)
    this.maxOutputTokens = options.maxOutputTokens ?? profile?.maxOutputTokens
    this.promptCaching = (options.promptCaching ?? true) && profile?.supportsPromptCaching === true
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
    let cacheReadTokens: number | undefined
    let cacheCreationTokens: number | undefined
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
            if (isTokenCount(item.message.usage.cache_read_input_tokens)) {
              cacheReadTokens = item.message.usage.cache_read_input_tokens
            }
            if (isTokenCount(item.message.usage.cache_creation_input_tokens)) {
              cacheCreationTokens = item.message.usage.cache_creation_input_tokens
            }
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
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
        ...(!(inputMeasured && outputMeasured) ? { status: 'unavailable' as const } : {}),
      },
    }
  }

  private async request(request: ModelRequest, stream: boolean): Promise<Response> {
    if (request.signal?.aborted) {
      throw abortedError()
    }
    const messages = request.messages.filter((message) => message.role !== 'system')
    const system = mergeSystemMessages(request.messages)
    // M4：max_tokens 由模型档案驱动；未登记模型保持原保守值。
    const maxTokens = this.maxOutputTokens ?? (request.reasoningEffort ? 16_384 : 8_192)
    const tools: Array<Record<string, unknown>> = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
    if (this.promptCaching && tools.length > 0) {
      // 工具定义位于提示前缀最前，最后一个工具标记 cache_control 覆盖整个工具清单。
      tools[tools.length - 1] = {
        ...tools[tools.length - 1]!,
        cache_control: { type: 'ephemeral' },
      }
    }
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      ...(request.reasoningEffort
        ? { thinking: { type: 'enabled', budget_tokens: reasoningBudget(request.reasoningEffort) } }
        : {}),
      ...(system
        ? {
            system: this.promptCaching
              ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
              : system,
          }
        : {}),
      messages: toAnthropicMessages(messages),
      tools: tools.length > 0 ? tools : undefined,
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

/**
 * Anthropic API 只接受单条 system；多条 system 消息（如提示词 + 压缩注记）
 * 按原顺序合并为单个有序块，避免只取第一条导致后续注记被静默丢弃。
 */
function mergeSystemMessages(messages: ModelMessage[]): string {
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter((content) => content.trim().length > 0)
    .join('\n\n')
}

/**
 * 转换为 Anthropic 消息序列：
 * - 跳过空文本块（API 拒绝空 text block）；
 * - 合并连续同角色消息（API 要求角色交替），tool_result 块保持在消息内容前部。
 */
function toAnthropicMessages(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const converted = messages
    .filter((message) => message.role !== 'system')
    .map(toAnthropicMessageBlocks)
    .filter((message) => message.content.length > 0)
  const merged: Array<{ role: string; content: Array<Record<string, unknown>> }> = []
  for (const message of converted) {
    const last = merged.at(-1)
    if (last && last.role === message.role) {
      last.content.push(...message.content)
      last.content.sort(toolResultFirst)
    } else {
      merged.push({ role: message.role, content: [...message.content] })
    }
  }
  return merged.map((message) => ({ role: message.role, content: message.content }))
}

function toolResultFirst(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftWeight = left.type === 'tool_result' ? 0 : 1
  const rightWeight = right.type === 'tool_result' ? 0 : 1
  return leftWeight - rightWeight
}

function toAnthropicMessageBlocks(message: ModelMessage): {
  role: 'user' | 'assistant'
  content: Array<Record<string, unknown>>
} {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }],
    }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    const content: Array<Record<string, unknown>> = []
    if (message.content.trim()) {
      content.push({ type: 'text', text: message.content })
    }
    for (const call of message.toolCalls) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
    }
    return { role: 'assistant', content }
  }
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content.trim() ? [{ type: 'text', text: message.content }] : [],
  }
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
    usage: measuredUsage(
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens,
    ),
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
