import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { ModelProvider } from './model-provider.js'
import type { ModelRequest, ModelResponse, ModelStopReason, ModelToolCall } from './model-types.js'

export type MockModelStep =
  | { kind: 'tool'; name: string; arguments: unknown; round?: number }
  | { kind: 'text'; text: string; stopReason?: ModelStopReason; round?: number }
  | { kind: 'error'; error: CodeDenError; round?: number }

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

/** 给任意剧本步骤标注"第 N 轮请求"生效；未命中轮次前不消耗 FIFO 顺序。 */
export function atRound(round: number, step: MockModelStep): MockModelStep {
  return { ...step, round: Math.max(1, Math.floor(round)) } as MockModelStep
}

/** 模拟 429/5xx 等 HTTP 错误：429 与 5xx 按可重试处理（EX-1）。 */
export function modelHttpError(status: number, message?: string): MockModelStep {
  return {
    kind: 'error',
    error: new CodeDenError({
      code: ErrorCodes.MODEL_REQUEST_FAILED,
      category: 'model',
      message: message ?? `Mock provider returned HTTP ${status}`,
      retryable: status === 429 || status >= 500,
    }),
  }
}

/** 超长文本输出（EX-7 相关）。 */
export function oversizedText(chars = 200_000, stopReason?: ModelStopReason): MockModelStep {
  return finalText('x'.repeat(Math.max(1, chars)), stopReason)
}

export class MockModelProvider implements ModelProvider {
  readonly name = 'mock-model'
  private readonly queue: MockModelStep[]
  private requestIndex = 0

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

    const step = this.takeStep()
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

  /**
   * M5：轮次标注步骤优先（requestIndex 与 round 相等时生效），其余按 FIFO。
   * 未命中轮次的标注步骤保持原地，直到轮次到达或 FIFO 耗尽后兜底消费。
   */
  private takeStep(): MockModelStep | undefined {
    this.requestIndex += 1
    const tagged = this.queue.findIndex((step) => step.round === this.requestIndex)
    if (tagged !== -1) {
      return this.queue.splice(tagged, 1)[0]
    }
    const untagged = this.queue.findIndex((step) => step.round === undefined)
    if (untagged !== -1) {
      return this.queue.splice(untagged, 1)[0]
    }
    return this.queue.shift()
  }
}
