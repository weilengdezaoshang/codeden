import OpenAI from 'openai'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import type { ModelProvider } from './model-provider.js'
import type { ModelMessage, ModelRequest, ModelResponse, ModelToolCall } from './model-types.js'

export interface OpenAIChatClient {
  chat: {
    completions: {
      create(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<OpenAIChatCompletion>
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

export interface OpenAIModelProviderOptions {
  name?: string
  client?: OpenAIChatClient
  model?: string
  apiKey?: string
  baseURL?: string
}

export class OpenAIModelProvider implements ModelProvider {
  readonly name: string
  private readonly client: OpenAIChatClient
  private readonly model: string

  constructor(options: OpenAIModelProviderOptions = {}) {
    this.name = options.name ?? 'openai'
    this.model = options.model ?? 'gpt-4.1-mini'
    this.client =
      options.client ??
      wrapOpenAI(
        new OpenAI({
          apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
          ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        }),
      )
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) {
      throw abortedError()
    }
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
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
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
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

function wrapOpenAI(client: OpenAI): OpenAIChatClient {
  return {
    chat: {
      completions: {
        create: async (body, options) => {
          return (await client.chat.completions.create(
            body as never,
            options,
          )) as OpenAIChatCompletion
        },
      },
    },
  }
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
  function: { name: string; arguments: string }
}): ModelToolCall {
  let args: unknown = {}
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
  } catch {
    throw new CodeDenError({
      code: ErrorCodes.MODEL_RESPONSE_INVALID,
      category: 'model',
      message: 'OpenAI tool call arguments were not valid JSON',
      retryable: false,
      details: { toolCallId: call.id, arguments: call.function.arguments },
    })
  }
  return {
    id: call.id,
    name: call.function.name,
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
  const message = error instanceof Error ? error.message : 'OpenAI request failed'
  const retryable = status === 429 || status === 408 || (status !== undefined && status >= 500)
  return new CodeDenError({
    code: ErrorCodes.MODEL_REQUEST_FAILED,
    category: 'model',
    message,
    retryable,
    details: { status },
  })
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
