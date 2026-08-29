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
  allowedTools?: readonly string[]
}

export class ToolExecutor {
  private readonly registry: ToolRegistry
  private readonly context: ToolContext
  private readonly budget: ToolBudget
  private readonly eventSink: EventSink
  private readonly clock: Clock
  private readonly timeoutMs: number
  private readonly allowedTools: Set<string> | undefined
  private readonly successfulTools = new Set<string>()
  private readonly researchedUrls = new Set<string>()

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry
    this.context = options.context
    this.budget = options.budget
    this.eventSink = options.eventSink
    this.clock = options.clock ?? new SystemClock()
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.allowedTools =
      options.allowedTools && options.allowedTools.length > 0
        ? new Set(options.allowedTools)
        : undefined
  }

  get metrics(): { toolCalls: number; toolFailures: number } {
    return {
      toolCalls: this.budget.used,
      toolFailures: this.failures,
    }
  }

  hasSuccessfulCall(...toolNames: string[]): boolean {
    return toolNames.some((name) => this.successfulTools.has(name))
  }

  hasSuccessfulResearch(): boolean {
    return (
      this.successfulTools.has('search_docs') &&
      [...this.researchedUrls].some((url) => url.startsWith('fetched:'))
    )
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
      if (this.allowedTools && !this.allowedTools.has(toolName)) {
        throw new CodeDenError({
          code: ErrorCodes.TOOL_NOT_FOUND,
          category: 'permission',
          message: `Tool is not allowed by the active skill: ${toolName}`,
          retryable: false,
          details: { toolName },
        })
      }
      if (toolName === 'subagent' && (this.context.subagentDepth ?? 0) > 0) {
        throw new CodeDenError({
          code: ErrorCodes.TOOL_NOT_FOUND,
          category: 'permission',
          message: 'Nested subagents are not allowed',
          retryable: false,
          details: { toolName, subagentDepth: this.context.subagentDepth },
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

      if (tool.sideEffect !== 'read' && this.context.confirmTool) {
        const approved = await this.context.confirmTool(
          toolName,
          redactorOf(this.context).redactValue(parsed.data),
          this.context.abortSignal,
        )
        if (!approved) {
          throw new CodeDenError({
            code: ErrorCodes.TOOL_PERMISSION_DENIED,
            category: 'permission',
            message: `Tool execution was denied: ${toolName}`,
            retryable: false,
            details: { toolName },
          })
        }
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
      this.successfulTools.add(toolName)
      this.recordResearchEvidence(toolName, safeOutput)
      await this.eventSink.emit('tool', 'tool.completed', {
        callId,
        toolName,
        durationMs,
        output: safeOutput,
      })
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

  private recordResearchEvidence(toolName: string, output: unknown): void {
    if (toolName === 'search_docs' && isSearchOutput(output)) {
      for (const result of output.results) {
        this.researchedUrls.add(result.url)
      }
    }
    if (toolName === 'fetch_url' && isFetchOutput(output) && this.researchedUrls.has(output.url)) {
      this.researchedUrls.add(`fetched:${output.url}`)
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

function isSearchOutput(value: unknown): value is { results: Array<{ url: string }> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'results' in value &&
    Array.isArray(value.results) &&
    value.results.every(
      (item) =>
        typeof item === 'object' && item !== null && 'url' in item && typeof item.url === 'string',
    )
  )
}

function isFetchOutput(value: unknown): value is { url: string } {
  return (
    typeof value === 'object' && value !== null && 'url' in value && typeof value.url === 'string'
  )
}
