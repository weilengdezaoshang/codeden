import OpenAI from 'openai'
import { isTokenCount, measuredUsage } from './token-usage.js'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { ResolvedSecret } from '@codeden/core/security/resolved-secret.js'
import type { ModelProvider } from './model-provider.js'
import type { ModelMessage, ModelRequest, ModelResponse, ModelToolCall } from './model-types.js'

export interface OpenAIChatClient {
  chat: {
    completions: {
      create(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<OpenAIChatCompletion | AsyncIterable<OpenAIChatChunk>>
    }
  }
}

export interface OpenAIChatCompletion {
  choices: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id: string
        function: {
          name: string
          arguments: string
        }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

export interface OpenAIChatChunk {
  choices: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface OpenAIModelProviderOptions {
  name?: string
  client?: OpenAIChatClient
  model?: string
  apiKey?: ResolvedSecret
  baseURL?: string
}

export class OpenAIModelProvider implements ModelProvider {
  readonly name: string
  private readonly client: OpenAIChatClient
  private readonly model: string

  get descriptor() {
    return { model: this.model, protocol: 'openai-compatible' }
  }

  constructor(options: OpenAIModelProviderOptions = {}) {
    this.name = options.name ?? 'openai'
    this.model = options.model ?? 'gpt-4.1-mini'
    if (options.client) {
      this.client = options.client
      return
    }
    if (!options.apiKey) {
      throw new CodeDenError({
        code: ErrorCodes.SECRET_ENV_NOT_FOUND,
        category: 'validation',
        message: 'Model provider requires an injected ResolvedSecret',
        retryable: false,
      })
    }
    this.client = wrapOpenAI(
      new OpenAI({
        apiKey: options.apiKey.exposeForTransport(),
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      }),
    )
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) {
      throw abortedError()
    }
    try {
      const completion = (await this.client.chat.completions.create(
        {
          model: this.model,
          reasoning_effort: request.reasoningEffort,
          messages: request.messages.map(toOpenAIMessage),
          tools:
            request.tools.length === 0
              ? undefined
              : request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
        },
        request.signal ? { signal: request.signal } : undefined,
      )) as OpenAIChatCompletion

      return mapCompletion(completion)
    } catch (error) {
      if (CodeDenError.isCodeDenError(error)) {
        throw error
      }
      throw mapOpenAIError(error, request.signal)
    }
  }

  async stream(
    request: ModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
  ): Promise<ModelResponse> {
    if (request.signal?.aborted) {
      throw abortedError()
    }
    try {
      const raw = await this.client.chat.completions.create(
        {
          model: this.model,
          reasoning_effort: request.reasoningEffort,
          stream: true,
          stream_options: { include_usage: true },
          messages: request.messages.map(toOpenAIMessage),
          tools:
            request.tools.length === 0
              ? undefined
              : request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
        },
        request.signal ? { signal: request.signal } : undefined,
      )
      if (!isAsyncIterable(raw)) {
        return mapCompletion(raw as OpenAIChatCompletion)
      }
      let text = ''
      let finishReason: string | null | undefined
      let inputTokens = 0
      let outputTokens = 0
      let usageAvailable = false
      const toolBuffers = new Map<number, { id: string; name: string; arguments: string }>()
      for await (const chunk of raw) {
        const choice = chunk.choices[0]
        finishReason = choice?.finish_reason ?? finishReason
        const delta = choice?.delta
        if (delta?.content) {
          text += delta.content
          await onTextDelta(delta.content)
        }
        for (const call of delta?.tool_calls ?? []) {
          const current = toolBuffers.get(call.index) ?? {
            id: call.id ?? `call_${call.index}`,
            name: '',
            arguments: '',
          }
          if (call.id) {
            current.id = call.id
          }
          if (call.function?.name) {
            current.name += call.function.name
          }
          if (call.function?.arguments) {
            current.arguments += call.function.arguments
          }
          toolBuffers.set(call.index, current)
        }
        if (chunk.usage) {
          usageAvailable =
            isTokenCount(chunk.usage.prompt_tokens) && isTokenCount(chunk.usage.completion_tokens)
          const measured = measuredUsage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens)
          inputTokens = measured.inputTokens
          outputTokens = measured.outputTokens
        }
      }
      const toolCalls = [...toolBuffers.values()].map((call) => parseToolCall(call))
      return {
        text,
        toolCalls,
        stopReason: mapStopReason(finishReason, toolCalls.length > 0),
        usage: {
          inputTokens,
          outputTokens,
          ...(!usageAvailable ? { status: 'unavailable' as const } : {}),
        },
      }
    } catch (error) {
      if (CodeDenError.isCodeDenError(error)) {
        throw error
      }
      throw mapOpenAIError(error, request.signal)
    }
  }
}

function mapCompletion(completion: OpenAIChatCompletion): ModelResponse {
  const choice = completion.choices[0]
  if (!choice?.message) {
    throw new CodeDenError({
      code: ErrorCodes.MODEL_RESPONSE_INVALID,
      category: 'model',
      message: 'OpenAI response contained no choices',
      retryable: false,
    })
  }
  const toolCalls = (choice.message.tool_calls ?? []).map(parseToolCall)
  return {
    text: choice.message.content ?? '',
    toolCalls,
    stopReason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
    usage: measuredUsage(completion.usage?.prompt_tokens, completion.usage?.completion_tokens),
  }
}

function wrapOpenAI(client: OpenAI): OpenAIChatClient {
  return {
    chat: {
      completions: {
        create: async (body, options) => {
          return (await client.chat.completions.create(body as never, options)) as
            OpenAIChatCompletion | AsyncIterable<OpenAIChatChunk>
        },
      },
    },
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<OpenAIChatChunk> {
  return Boolean(value && typeof value === 'object' && Symbol.asyncIterator in value)
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    }
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      })),
    }
  }
  return {
    role: message.role,
    content: message.content,
  }
}

function parseToolCall(call: {
  id: string
  function?: { name: string; arguments: string }
  name?: string
  arguments?: string
}): ModelToolCall {
  let args: unknown = {}
  const name = call.function?.name ?? call.name ?? ''
  const rawArguments = call.function?.arguments ?? call.arguments ?? ''
  try {
    args = rawArguments ? JSON.parse(rawArguments) : {}
  } catch {
    throw new CodeDenError({
      code: ErrorCodes.MODEL_RESPONSE_INVALID,
      category: 'model',
      message: 'OpenAI tool call arguments were not valid JSON',
      retryable: false,
      details: { toolCallId: call.id, arguments: rawArguments },
    })
  }
  return {
    id: call.id,
    name,
    arguments: args,
  }
}

function mapStopReason(
  reason: string | null | undefined,
  hasTools: boolean,
): ModelResponse['stopReason'] {
  if (reason === 'tool_calls' || hasTools) {
    return 'tool_use'
  }
  if (reason === 'length') {
    return 'max_tokens'
  }
  if (reason === 'stop') {
    return 'end_turn'
  }
  return 'unknown'
}

function abortedError(): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.AGENT_TIMEOUT,
    category: 'timeout',
    message: 'OpenAI request aborted',
    retryable: false,
  })
}

function mapOpenAIError(error: unknown, signal?: AbortSignal): CodeDenError {
  if (signal?.aborted || isAbortLike(error)) {
    return abortedError()
  }
  const status = getStatus(error)
  const rawMessage = error instanceof Error ? error.message : 'OpenAI request failed'
  const message = sanitizeProviderMessage(rawMessage)
  const retryable = status === 429 || status === 408 || (status !== undefined && status >= 500)
  return new CodeDenError({
    code: status === 401 ? ErrorCodes.MODEL_AUTHENTICATION_FAILED : ErrorCodes.MODEL_REQUEST_FAILED,
    category: 'model',
    message,
    retryable,
    details: {
      status,
      requestId: getRequestId(error),
    },
  })
}

function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer <redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/g, 'Bearer <redacted>')
    .replace(/sk-[A-Za-z0-9]+/g, '<redacted>')
    .replace(/xai-[A-Za-z0-9]+/g, '<redacted>')
}

function getRequestId(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'requestID' in error &&
    typeof error.requestID === 'string'
  ) {
    return error.requestID
  }
  return undefined
}

function isAbortLike(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false
  }
  return error.name === 'AbortError' || error.name === 'APIUserAbortError'
}

function getStatus(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  ) {
    return error.status
  }
  return undefined
}
