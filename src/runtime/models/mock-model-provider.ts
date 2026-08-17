import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import type { ModelProvider } from './model-provider.js'
import type { ModelRequest, ModelResponse, ModelToolCall } from './model-types.js'

export type MockModelStep =
  | { kind: 'tool'; name: string; arguments: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'error'; error: CodeDenError }

let mockCallSeq = 0

export function toolCall(name: string, args: unknown): MockModelStep {
  return { kind: 'tool', name, arguments: args }
}

export function finalText(text: string): MockModelStep {
  return { kind: 'text', text }
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
        stopReason: 'end_turn',
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
}
