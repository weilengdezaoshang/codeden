import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { ModelProvider } from './model-provider.js'
import type { ModelRequest, ModelResponse, ModelStopReason, ModelToolCall } from './model-types.js'

export type MockModelStep =
  | { kind: 'tool'; name: string; arguments: unknown }
  | { kind: 'text'; text: string; stopReason?: ModelStopReason }
  | { kind: 'error'; error: CodeDenError }

let mockCallSeq = 0

export function toolCall(name: string, args: unknown): MockModelStep {
  return { kind: 'tool', name, arguments: args }
}

/** stopReason 可剧本化：'max_tokens' 用于截断续写（EX-2）相关用例。 */
export function finalText(text: string, stopReason?: ModelStopReason): MockModelStep {
  return { kind: 'text', text, ...(stopReason ? { stopReason } : {}) }
}

export function modelError(error: CodeDenError): MockModelStep {
  return { kind: 'error', error }
}

export class MockModelProvider implements ModelProvider {
  readonly name = 'mock-model'
  private readonly queue: MockModelStep[]

  constructor(steps: MockModelStep[]) {
    this.queue = [...steps]
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) {
      throw new CodeDenError({
        code: ErrorCodes.AGENT_TIMEOUT,
        category: 'timeout',
        message: 'Model request aborted',
        retryable: false,
      })
    }

    const step = this.queue.shift()
    if (!step) {
      throw new CodeDenError({
        code: ErrorCodes.MODEL_RESPONSE_INVALID,
        category: 'model',
        message: 'MockModelProvider has no remaining scripted responses',
        retryable: false,
      })
    }

    if (step.kind === 'error') {
      throw step.error
    }

    if (step.kind === 'text') {
      return {
        text: step.text,
        toolCalls: [],
        stopReason: step.stopReason ?? 'end_turn',
        usage: { inputTokens: 8, outputTokens: 4 },
      }
    }

    const call: ModelToolCall = {
      id: `call_${++mockCallSeq}`,
      name: step.name,
      arguments: step.arguments,
    }

    return {
      text: '',
      toolCalls: [call],
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 6 },
    }
  }

  async stream(
    request: ModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
  ): Promise<ModelResponse> {
    const response = await this.complete(request)
    if (response.text) {
      const midpoint = Math.max(1, Math.ceil(response.text.length / 2))
      await onTextDelta(response.text.slice(0, midpoint))
      if (response.text.length > midpoint) {
        await onTextDelta(response.text.slice(midpoint))
      }
    }
    return response
  }
}
