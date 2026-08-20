import type { Clock } from '../../core/clock.js'
import { SystemClock } from '../../core/clock.js'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import type { EventSink } from '../../core/events/event-sink.js'
import { redactorOf } from '../../security/tool-security.js'
import type { ModelToolCall } from '../models/model-types.js'
import type { ToolContext } from './tool.js'
import type { ToolRegistry } from './tool-registry.js'
import type { ToolResult } from './tool-result.js'

export interface ToolBudget {
  readonly maxToolCalls: number
  used: number
}

export interface ToolExecutorOptions {
  registry: ToolRegistry
  context: ToolContext
  budget: ToolBudget
  eventSink: EventSink
  clock?: Clock
  timeoutMs?: number
}

export class ToolExecutor {
  private readonly registry: ToolRegistry
  private readonly context: ToolContext
  private readonly budget: ToolBudget
  private readonly eventSink: EventSink
  private readonly clock: Clock
  private readonly timeoutMs: number

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry
    this.context = options.context
    this.budget = options.budget
    this.eventSink = options.eventSink
    this.clock = options.clock ?? new SystemClock()
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  get metrics(): { toolCalls: number; toolFailures: number } {
    return {
      toolCalls: this.budget.used,
      toolFailures: this.failures,
    }
  }

  private failures = 0

  async execute(toolCall: ModelToolCall): Promise<ToolResult> {
    const started = this.clock.monotonicMs()
    const toolName = toolCall.name
    const callId = toolCall.id

    try {
      const tool = this.registry.get(toolName)
      if (!tool) {
        throw new CodeDenError({
          code: ErrorCodes.TOOL_NOT_FOUND,
          category: 'tool',
          message: `Unknown tool: ${toolName}`,
          retryable: false,
          details: { toolName },
        })
      }

      const parsed = tool.inputSchema.safeParse(toolCall.arguments)
      if (!parsed.success) {
        throw new CodeDenError({
          code: ErrorCodes.TOOL_INPUT_INVALID,
          category: 'validation',
          message: `Invalid arguments for ${toolName}`,
          retryable: false,
          details: {
            toolName,
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              message: issue.message,
            })),
          },
        })
      }

      if (this.budget.used >= this.budget.maxToolCalls) {
        throw new CodeDenError({
          code: ErrorCodes.AGENT_BUDGET_EXHAUSTED,
          category: 'tool',
          message: `Tool call budget exhausted (${this.budget.maxToolCalls})`,
          retryable: false,
        })
      }

      this.budget.used += 1
      await this.eventSink.emit('tool', 'tool.started', {
        callId,
        toolName,
        arguments: parsed.data,
      })

      const output = await this.withTimeout(toolName, (signal) =>
        tool.execute(parsed.data, { ...this.context, abortSignal: signal }),
      )
      const durationMs = Math.max(0, this.clock.monotonicMs() - started)
      const safeOutput = redactorOf(this.context).redactValue(output)
      await this.eventSink.emit('tool', 'tool.completed', { callId, toolName, durationMs })
      return { ok: true, callId, toolName, output: safeOutput, durationMs }
    } catch (error) {
      this.failures += 1
      const codeden = toToolError(error, toolName)
      const durationMs = Math.max(0, this.clock.monotonicMs() - started)
      const safeError = redactorOf(this.context).redactValue(codeden.toData()) as ReturnType<
        typeof codeden.toData
      >
      await this.eventSink.emit('tool', 'tool.failed', {
        callId,
        toolName,
        durationMs,
        error: safeError,
      })
      return { ok: false, callId, toolName, error: safeError, durationMs }
    }
  }

  private async withTimeout<T>(
    toolName: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const onParentAbort = () => controller.abort()
    this.context.abortSignal?.addEventListener('abort', onParentAbort)
    if (this.context.abortSignal?.aborted) {
      controller.abort()
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        run(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(
              new CodeDenError({
                code: ErrorCodes.COMMAND_TIMEOUT,
                category: 'timeout',
                message: `Tool timed out: ${toolName}`,
                retryable: false,
                details: { toolName, timeoutMs: this.timeoutMs },
              }),
            )
          }, this.timeoutMs)
        }),
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
      this.context.abortSignal?.removeEventListener('abort', onParentAbort)
    }
  }
}

function toToolError(error: unknown, toolName: string): CodeDenError {
  if (CodeDenError.isCodeDenError(error)) {
    return error
  }
  return new CodeDenError({
    code: ErrorCodes.TOOL_EXECUTION_FAILED,
    category: 'tool',
    message: error instanceof Error ? error.message : `Tool failed: ${toolName}`,
    retryable: false,
    details: { toolName },
  })
}
