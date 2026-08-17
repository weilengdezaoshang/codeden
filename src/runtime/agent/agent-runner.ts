import type { Clock } from '../../core/clock.js'
import { SystemClock } from '../../core/clock.js'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import { AgentStateMachine } from '../../core/task/task-state.js'
import { emptyMetrics } from '../../eval/domain/metrics.js'
import type {
  AgentPort,
  AgentRunContext,
  AgentRunResult,
  AgentTask,
} from '../../eval/ports/agent.port.js'
import type { ModelProvider } from '../models/model-provider.js'
import type { ModelMessage, ModelResponse } from '../models/model-types.js'
import type { ToolExecutor } from '../tools/tool-executor.js'
import type { ToolRegistry } from '../tools/tool-registry.js'
import { collectSubmission } from './completion-policy.js'

export interface AgentRunnerDeps {
  model: ModelProvider
  registry: ToolRegistry
  createExecutor: (context: AgentRunContext) => ToolExecutor
  clock?: Clock
}

export class AgentRunner {
  private readonly model: ModelProvider
  private readonly registry: ToolRegistry
  private readonly createExecutor: (context: AgentRunContext) => ToolExecutor
  private readonly clock: Clock

  constructor(deps: AgentRunnerDeps) {
    this.model = deps.model
    this.registry = deps.registry
    this.createExecutor = deps.createExecutor
    this.clock = deps.clock ?? new SystemClock()
  }

  async run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult> {
    const state = new AgentStateMachine()
    state.transition('RUNNING')
    await context.eventSink.emit('agent', 'agent.started', { taskId: task.taskSpec.id })

    const allowedPaths = context.allowedPaths ?? task.taskSpec.allowedPaths
    const scopedContext: AgentRunContext = { ...context, allowedPaths }
    const executor = this.createExecutor(scopedContext)
    const messages: ModelMessage[] = [
      { role: 'system', content: buildSystemPrompt(task) },
      { role: 'user', content: task.prompt },
    ]

    let turns = 0
    let modelRequests = 0
    let inputTokens = 0
    let outputTokens = 0
    let finalResponse = ''
    let stopReason: string | undefined

    try {
      while (state.state === 'RUNNING') {
        this.throwIfAborted(scopedContext)
        if (turns >= scopedContext.limits.maxTurns) {
          state.transition('BUDGET_EXHAUSTED')
          stopReason = 'maxTurns'
          break
        }

        turns += 1
        modelRequests += 1
        await scopedContext.eventSink.emit('model', 'model.requested', { turn: turns })

        let response: ModelResponse
        try {
          response = await this.model.complete({
            messages,
            tools: this.registry.definitions(),
            signal: scopedContext.abortSignal,
          })
        } catch (error) {
          await scopedContext.eventSink.emit('model', 'model.failed', { error: toErrorData(error) })
          throw error
        }

        inputTokens += response.usage.inputTokens
        outputTokens += response.usage.outputTokens
        await scopedContext.eventSink.emit('model', 'model.completed', {
          turn: turns,
          stopReason: response.stopReason,
          toolCalls: response.toolCalls.length,
        })

        if (response.toolCalls.length === 0) {
          finalResponse = response.text
          state.transition('MODEL_PROPOSED_COMPLETE')
          await scopedContext.eventSink.emit('agent', 'agent.completion_proposed', {
            text: finalResponse,
          })
          break
        }

        messages.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls,
        })

        for (const toolCall of response.toolCalls) {
          this.throwIfAborted(scopedContext)
          const result = await executor.execute(toolCall)
          if (!result.ok && result.error.code === ErrorCodes.AGENT_BUDGET_EXHAUSTED) {
            state.transition('BUDGET_EXHAUSTED')
            stopReason = 'maxToolCalls'
            break
          }
          messages.push({
            role: 'tool',
            content: JSON.stringify(result.ok ? result.output : result.error),
            toolCallId: result.callId,
          })
        }

        if (state.state !== 'RUNNING') {
          break
        }
      }

      if (state.state === 'MODEL_PROPOSED_COMPLETE') {
        const submission = await collectSubmission(scopedContext, finalResponse)
        state.transition('SUBMITTED')
        await scopedContext.eventSink.emit('agent', 'agent.submitted', { submission })
        return {
          status: 'submitted',
          stopReason,
          finalResponse,
          submission,
          metrics: this.metrics(executor, { turns, modelRequests, inputTokens, outputTokens }),
        }
      }

      if (state.state === 'BUDGET_EXHAUSTED') {
        return {
          status: 'budget_exhausted',
          stopReason: stopReason ?? 'budget_exhausted',
          finalResponse,
          metrics: this.metrics(executor, { turns, modelRequests, inputTokens, outputTokens }),
        }
      }

      throw new CodeDenError({
        code: ErrorCodes.INTERNAL_INVARIANT_VIOLATION,
        category: 'internal',
        message: `Agent loop ended in unexpected state: ${state.state}`,
        retryable: false,
      })
    } catch (error) {
      if (
        scopedContext.abortSignal?.aborted ||
        isAbortError(error) ||
        isCode(error, ErrorCodes.AGENT_TIMEOUT)
      ) {
        if (state.state === 'RUNNING') {
          state.transition('TIMEOUT')
        }
        return {
          status: 'timeout',
          stopReason: 'timeout',
          finalResponse,
          metrics: this.metrics(executor, { turns, modelRequests, inputTokens, outputTokens }),
        }
      }

      if (state.state === 'RUNNING' || state.state === 'MODEL_PROPOSED_COMPLETE') {
        state.transition('FAILED')
      }

      return {
        status: 'agent_error',
        stopReason: error instanceof Error ? error.message : 'agent_error',
        finalResponse,
        metrics: this.metrics(executor, { turns, modelRequests, inputTokens, outputTokens }),
      }
    }
  }

  private metrics(
    executor: ToolExecutor,
    parts: { turns: number; modelRequests: number; inputTokens: number; outputTokens: number },
  ) {
    const tool = executor.metrics
    return emptyMetrics({
      turns: parts.turns,
      modelRequests: parts.modelRequests,
      toolCalls: tool.toolCalls,
      toolFailures: tool.toolFailures,
      inputTokens: parts.inputTokens,
      outputTokens: parts.outputTokens,
    })
  }

  private throwIfAborted(context: AgentRunContext): void {
    if (context.abortSignal?.aborted) {
      throw new CodeDenError({
        code: ErrorCodes.AGENT_TIMEOUT,
        category: 'timeout',
        message: 'Agent run aborted',
        retryable: false,
      })
    }
  }
}

export class CodeDenAgentRuntime implements AgentPort {
  readonly name: string
  private readonly runner: AgentRunner

  constructor(deps: AgentRunnerDeps & { name?: string }) {
    this.runner = new AgentRunner(deps)
    this.name = deps.name ?? `codeden/${deps.model.name}`
  }

  run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult> {
    return this.runner.run(task, context)
  }
}

function buildSystemPrompt(task: AgentTask): string {
  const spec = task.taskSpec
  return [
    'You are CodeDen, a coding agent. Use tools to complete the task.',
    `Goal: ${spec.goal}`,
    spec.acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n- ${spec.acceptanceCriteria.join('\n- ')}`
      : '',
    spec.constraints.length > 0 ? `Constraints:\n- ${spec.constraints.join('\n- ')}` : '',
    `Allowed paths: ${spec.allowedPaths.join(', ')}`,
    'When the task is done, reply with a final message and no tool calls.',
  ]
    .filter(Boolean)
    .join('\n')
}

function toErrorData(error: unknown) {
  if (CodeDenError.isCodeDenError(error)) {
    return error.toData()
  }
  return {
    code: ErrorCodes.MODEL_REQUEST_FAILED,
    category: 'model' as const,
    message: error instanceof Error ? error.message : 'Model request failed',
    retryable: false,
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false
  }
  return error.name === 'AbortError' || error.name === 'APIUserAbortError'
}

function isCode(error: unknown, code: string): boolean {
  return CodeDenError.isCodeDenError(error) && error.code === code
}
