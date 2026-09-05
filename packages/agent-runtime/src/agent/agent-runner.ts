import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentEventScope } from './agent-event-scope.js'
import type { Clock } from '@codeden/core/clock.js'
import { SystemClock } from '@codeden/core/clock.js'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { AgentStateMachine } from '@codeden/core/task/task-state.js'
import { emptyMetrics } from '@codeden/core/metrics.js'
import type { AgentPort, AgentRunContext, AgentRunResult, AgentTask } from './agent-contracts.js'
import { InMemorySecretRegistry } from '@codeden/core/security/secret-registry.js'
import { SecretRedactor } from '@codeden/core/security/secret-redactor.js'
import type { ModelProvider } from '../models/model-provider.js'
import type { ModelResponse } from '../models/model-types.js'
import { ModelUsageSchema } from '../models/model-types.js'
import { builtinModelProfile } from '../models/builtin-providers.js'
import {
  computeUtilization,
  DEFAULT_CONTEXT_BUDGET_POLICY,
  resolveModelProfile,
  type ContextBudgetPolicy,
} from '../context/context-budget.js'
import { ResearchPolicy } from '../research/research-policy.js'
import type { ToolExecutor } from '../tools/tool-executor.js'
import type { ToolRegistry } from '../tools/tool-registry.js'
import { clipHeadTail, MAX_MODEL_FEEDBACK_CHARS } from '../verification/clip-text.js'
import type { CompletionVerifier } from '../verification/completion-verifier.js'
import { collectSubmission } from './completion-policy.js'
import { PromptComposer } from '../prompt/prompt-composer.js'
import { diagnoseInstructionConflicts, InstructionLoader } from '../prompt/instruction-loader.js'

export interface AgentRunnerDeps {
  model: ModelProvider
  registry: ToolRegistry
  createExecutor: (context: AgentRunContext) => ToolExecutor
  clock?: Clock
  verifier?: CompletionVerifier
  redactor?: SecretRedactor
  researchPolicy?: ResearchPolicy
  /** Provider 是否支持工具调用；关闭时不向模型暴露任何工具。 */
  toolsEnabled?: boolean
  /** 上下文预算策略；缺省用默认阈值，仅随 context.utilization 事件观测。 */
  contextBudget?: ContextBudgetPolicy
}

export class AgentRunner {
  readonly name: string
  private readonly model: ModelProvider
  private readonly registry: ToolRegistry
  private readonly createExecutor: (context: AgentRunContext) => ToolExecutor
  private readonly clock: Clock
  private readonly verifier: CompletionVerifier | undefined
  private readonly redactor: SecretRedactor
  private readonly researchPolicy: ResearchPolicy
  private readonly toolsEnabled: boolean
  private readonly contextBudget: ContextBudgetPolicy
  private readonly promptComposer = new PromptComposer()
  private readonly instructionLoader = new InstructionLoader()

  constructor(deps: AgentRunnerDeps) {
    this.name = `codeden/${deps.model.name}`
    this.model = deps.model
    this.registry = deps.registry
    this.createExecutor = deps.createExecutor
    this.clock = deps.clock ?? new SystemClock()
    this.verifier = deps.verifier
    this.redactor = deps.redactor ?? new SecretRedactor(new InMemorySecretRegistry())
    this.researchPolicy = deps.researchPolicy ?? new ResearchPolicy()
    this.toolsEnabled = deps.toolsEnabled ?? true
    this.contextBudget = deps.contextBudget ?? DEFAULT_CONTEXT_BUDGET_POLICY
  }

  /** 可重试错误（限流、5xx 等）按指数退避重试；流式已产出增量时不重试，避免重复输出。 */
  private async requestModelWithRetry(
    context: AgentRunContext,
    request: Parameters<ModelProvider['complete']>[0],
    onTextDelta: (delta: string) => Promise<void>,
    hasEmittedDelta: () => boolean,
  ): Promise<ModelResponse> {
    const maxRetries = Math.max(0, context.limits.modelRetries ?? 2)
    for (let attempt = 0; ; attempt += 1) {
      try {
        return this.model.stream
          ? await this.model.stream(request, onTextDelta)
          : await this.model.complete(request)
      } catch (error) {
        if (
          attempt >= maxRetries ||
          hasEmittedDelta() ||
          context.abortSignal?.aborted ||
          !this.isRetryableModelError(error)
        ) {
          throw error
        }
        const delayMs = Math.min(8_000, 500 * 2 ** attempt)
        await context.eventSink.emit('model', 'model.retry', {
          attempt: attempt + 1,
          delayMs,
          error: toErrorData(error),
        })
        await delayWithAbort(context.abortSignal, delayMs)
      }
    }
  }

  private isRetryableModelError(error: unknown): boolean {
    return (
      CodeDenError.isCodeDenError(error) && error.category === 'model' && error.retryable === true
    )
  }

  async run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult> {
    const eventScope = createAgentEventScope(context)
    context = eventScope.context
    const state = new AgentStateMachine()
    state.transition('RUNNING')
    await context.eventSink.emit('agent', 'agent.started', {
      agentName: this.name,
      model: this.model.descriptor ?? { model: this.model.name, protocol: 'unknown' },
      taskId: task.taskSpec.id,
      prompt: task.prompt,
      taskSpec: task.taskSpec,
    })

    const allowedPaths = context.allowedPaths ?? task.taskSpec.allowedPaths
    const scopedContext: AgentRunContext = { ...context, allowedPaths }
    // 整轮墙钟预算：与外部取消信号合并，超时走统一的 timeout 收口。
    const runTimeoutMs = scopedContext.limits.runTimeoutMs
    if (runTimeoutMs !== undefined && runTimeoutMs > 0) {
      const deadline = AbortSignal.timeout(runTimeoutMs)
      scopedContext.abortSignal = scopedContext.abortSignal
        ? AbortSignal.any([scopedContext.abortSignal, deadline])
        : deadline
    }
    const completionVerifier = scopedContext.completionVerifier ?? this.verifier
    const executor = this.createExecutor(scopedContext)
    const researchDecision = this.researchPolicy.assess(task.prompt)
    let researchRequired = researchDecision.level === 'required'
    const searchAvailable = this.toolsEnabled && Boolean(this.registry.get('search_docs'))
    const fetchAvailable = this.toolsEnabled && Boolean(this.registry.get('fetch_url'))
    const researchAvailable = searchAvailable || fetchAvailable
    const instructions = await this.instructionLoader.loadHierarchy(scopedContext.workspace.root, {
      includeUser: scopedContext.includeUserInstructions ?? true,
      includeParents: scopedContext.includeUserInstructions !== false,
    })
    const instructionConflicts = diagnoseInstructionConflicts(instructions)
    await scopedContext.eventSink.emit('agent', 'agent.instructions_loaded', {
      files: instructions.map((instruction) => instruction.file),
      instructions: instructions.map((instruction) => ({
        file: instruction.file,
        kind: instruction.kind,
        scope: instruction.scope ?? 'project',
        digest: digest(instruction.content),
      })),
      conflictCount: instructionConflicts.length,
      conflicts: instructionConflicts,
    })
    const messages = this.promptComposer.compose({
      task,
      researchInstructions: this.researchPolicy.instructions(researchDecision, searchAvailable),
      readOnly: scopedContext.readOnly ?? false,
      conversation: scopedContext.conversation,
      instructions,
      persona: scopedContext.persona,
      memory: scopedContext.memory,
      skills: scopedContext.skills,
      activeSkill: scopedContext.activeSkill,
    })
    const composedCount = messages.length
    const finish = (result: AgentRunResult) => {
      return this.finish(scopedContext, {
        ...result,
        turnTranscript: messages.slice(composedCount),
        metrics: eventScope.aggregate(result.metrics),
      })
    }
    await scopedContext.eventSink.emit('agent', 'agent.prompt_composed', {
      messageCount: messages.length,
      instructionFiles: instructions.map((instruction) => instruction.file),
      instructionConflictCount: instructionConflicts.length,
      hasPersona: Boolean(scopedContext.persona?.trim()),
      includeUserInstructions: scopedContext.includeUserInstructions ?? true,
      personaDigest: scopedContext.persona?.trim()
        ? digest(scopedContext.persona.trim())
        : undefined,
      promptDigest: digest(JSON.stringify(messages)),
      memoryEntries: scopedContext.memory?.length ?? 0,
      activeSkill: scopedContext.activeSkill,
    })

    let turns = 0
    let modelRequests = 0
    let inputTokens = 0
    let outputTokens = 0
    let measuredTokenRequests = 0
    let finalResponse = ''
    let stopReason: string | undefined
    let verifiedSnapshot: AgentRunResult['verifiedSnapshot']
    let verification: AgentRunResult['verification']
    const recentToolCallSignatures: string[] = []
    // 上下文占用观测（M0）：按模型档案估算窗口占用，仅随事件上报，不改任何行为。
    const modelProfile = resolveModelProfile(builtinModelProfile(this.model.descriptor?.model))

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
        let response: ModelResponse
        let deltaEmitted = false
        const onTextDelta = async (delta: string) => {
          if (!delta) {
            return
          }
          deltaEmitted = true
          await scopedContext.eventSink.emit('model', 'model.text_delta', { delta })
          await scopedContext.onTextDelta?.(delta)
        }
        try {
          const request = {
            messages,
            tools: this.toolsEnabled
              ? this.registry
                  .definitions(scopedContext.readOnly ?? false)
                  .filter((tool) => this.isToolAllowedBySkill(tool.name, scopedContext))
                  .filter((tool) =>
                    scopedContext.subagentDepth !== undefined && scopedContext.subagentDepth > 0
                      ? tool.name !== 'subagent'
                      : true,
                  )
              : [],
            signal: scopedContext.abortSignal,
            reasoningEffort: scopedContext.reasoningEffort,
          }
          await scopedContext.eventSink.emit('context', 'context.utilization', {
            turn: turns,
            ...computeUtilization(request.messages, modelProfile, this.contextBudget),
          })
          await scopedContext.eventSink.emit('model', 'model.requested', {
            turn: turns,
            messages: request.messages,
            tools: request.tools,
          })
          response = await this.requestModelWithRetry(
            scopedContext,
            request,
            onTextDelta,
            () => deltaEmitted,
          )
          response.usage = ModelUsageSchema.parse(response.usage)
          if (!this.model.stream && response.text) {
            await onTextDelta(response.text)
          }
        } catch (error) {
          await scopedContext.eventSink.emit('model', 'model.failed', {
            error: toErrorData(error),
            terminal: true,
            turn: turns,
          })
          throw error
        }

        inputTokens += response.usage.inputTokens
        outputTokens += response.usage.outputTokens
        if (response.usage.status !== 'unavailable') {
          measuredTokenRequests += 1
        }
        await scopedContext.eventSink.emit('model', 'model.completed', {
          turn: turns,
          stopReason: response.stopReason,
          text: response.text,
          toolCalls: response.toolCalls,
          usage: response.usage,
        })

        if (response.toolCalls.length === 0) {
          finalResponse = response.text
          if (
            researchRequired &&
            researchAvailable &&
            ((searchAvailable && !executor.hasSuccessfulResearch()) ||
              (!searchAvailable && !executor.hasSuccessfulCall('fetch_url')))
          ) {
            messages.push({ role: 'assistant', content: finalResponse })
            messages.push({
              role: 'user',
              content:
                'Research evidence is required for this task, but no documentation research tool completed successfully. Use search_docs and fetch_url before proposing completion.',
            })
            continue
          }
          if (
            researchRequired &&
            executor.hasSuccessfulResearch() &&
            !/https:\/\/\S+/iu.test(finalResponse)
          ) {
            messages.push({ role: 'assistant', content: finalResponse })
            messages.push({
              role: 'user',
              content:
                'Research was used. Include the supporting source URL(s) in the final response before proposing completion.',
            })
            continue
          }
          state.transition('MODEL_PROPOSED_COMPLETE')
          await scopedContext.eventSink.emit('agent', 'agent.completion_proposed', {
            text: finalResponse,
          })
          messages.push({ role: 'assistant', content: finalResponse })
          if (!completionVerifier || scopedContext.readOnly) {
            break
          }
          const check = await completionVerifier.verify(task.taskSpec, scopedContext.workspace)
          if (check.passed) {
            verification = redactCompletionCheck(check, this.redactor)
            await scopedContext.eventSink.emit('verifier', 'verification.completed', verification)
            verifiedSnapshot = check.verifiedSnapshot
            state.transition('VERIFIED_COMPLETE')
            break
          }
          const redacted = redactCompletionCheck(check, this.redactor)
          verification = redacted
          await scopedContext.eventSink.emit('verifier', 'verification.failed', redacted)
          state.transition('RUNNING')
          messages.push({
            role: 'user',
            content: clipHeadTail(
              [
                `Verification failed: ${redacted.message}`,
                ...redacted.evidence,
                'Continue fixing. When done, reply with a final message and no tool calls.',
              ].join('\n'),
              MAX_MODEL_FEEDBACK_CHARS,
            ),
          })
          continue
        }

        messages.push({
          role: 'assistant',
          content: response.text,
          ...(this.toolsEnabled ? { toolCalls: response.toolCalls } : {}),
        })

        if (!this.toolsEnabled) {
          messages.push({
            role: 'user',
            content:
              'The configured model provider does not support tool calls. Respond with a final answer without invoking tools.',
          })
          continue
        }

        // 最近 executed 签名窗口：既捕获连续重复，也捕获 A/B/A/B 交替空转。
        const executedCallIds = new Set<string>()
        let researchEscalation = false
        for (const toolCall of response.toolCalls) {
          this.throwIfAborted(scopedContext)
          const toolCallSignature = `${toolCall.name}:${stableSerialize(toolCall.arguments)}`
          recentToolCallSignatures.push(toolCallSignature)
          if (recentToolCallSignatures.length > RECENT_TOOL_CALL_WINDOW) {
            recentToolCallSignatures.shift()
          }
          const occurrences = recentToolCallSignatures.filter(
            (signature) => signature === toolCallSignature,
          ).length
          if (occurrences >= REPEATED_TOOL_CALL_LIMIT) {
            await scopedContext.eventSink.emit('tool', 'tool.failed', {
              callId: toolCall.id,
              toolName: toolCall.name,
              error: {
                message: `Repeated identical tool call stopped after ${occurrences} occurrences`,
              },
            })
            state.transition('BUDGET_EXHAUSTED')
            stopReason = 'repeatedToolCall'
            break
          }
          const result = await executor.execute(toolCall)
          if (!result.ok && result.error.code === ErrorCodes.TOOL_PERMISSION_DENIED) {
            // 权限拒绝是用户对当前操作的明确终止，不应作为普通工具失败回传给模型，
            // 否则模型可能立即重试同一个命令，让用户误以为拒绝没有生效。
            throw new CodeDenError({
              code: result.error.code,
              category: result.error.category,
              message: result.error.message,
              retryable: false,
              details: result.error.details,
            })
          }
          if (!result.ok && this.researchPolicy.shouldEscalateAfterFailure(result.error.message)) {
            // 升级提示延后到本响应全部工具结果之后，保证消息序列对模型协议合法。
            researchRequired = true
            researchEscalation = true
          }
          if (!result.ok && result.error.code === ErrorCodes.AGENT_BUDGET_EXHAUSTED) {
            state.transition('BUDGET_EXHAUSTED')
            stopReason = 'maxToolCalls'
            break
          }
          // 只有真正执行过的调用才计入已执行集合；预算拒绝的调用留给占位结果。
          executedCallIds.add(toolCall.id)
          messages.push({
            role: 'tool',
            content: JSON.stringify(result.ok ? result.output : result.error),
            toolCallId: result.callId,
          })
        }

        // 中途熔断时为未执行的工具调用补齐占位结果，避免悬空 tool_call 破坏后续请求。
        for (const toolCall of response.toolCalls) {
          if (!executedCallIds.has(toolCall.id)) {
            messages.push({
              role: 'tool',
              content: JSON.stringify({
                code: 'AGENT_STOPPED',
                message: '工具调用未执行：执行循环已停止。',
              }),
              toolCallId: toolCall.id,
            })
          }
        }
        if (researchEscalation) {
          messages.push({
            role: 'user',
            content:
              'The tool result indicates an unfamiliar or version-sensitive API. Treat this as a research trigger: inspect local types first, then use search_docs and fetch_url before continuing.',
          })
        }

        if (state.state !== 'RUNNING') {
          break
        }
      }

      if (state.state === 'VERIFIED_COMPLETE' || state.state === 'MODEL_PROPOSED_COMPLETE') {
        const submission = await collectSubmission(scopedContext, finalResponse)
        if (state.state === 'MODEL_PROPOSED_COMPLETE') {
          state.transition('SUBMITTED')
        }
        await scopedContext.eventSink.emit('agent', 'agent.submitted', { submission })
        return await finish({
          status: state.state === 'VERIFIED_COMPLETE' ? 'verified_complete' : 'submitted',
          stopReason,
          finalResponse,
          submission,
          ...(verifiedSnapshot ? { verifiedSnapshot } : {}),
          ...(verification ? { verification } : {}),
          metrics: this.metrics(executor, {
            turns,
            modelRequests,
            inputTokens,
            outputTokens,
            measuredTokenRequests,
          }),
        })
      }

      if (state.state === 'BUDGET_EXHAUSTED') {
        const submission = await collectSubmission(scopedContext, finalResponse)
        return await finish({
          status: 'budget_exhausted',
          stopReason: stopReason ?? 'budget_exhausted',
          finalResponse,
          submission,
          ...(verification ? { verification } : {}),
          metrics: this.metrics(executor, {
            turns,
            modelRequests,
            inputTokens,
            outputTokens,
            measuredTokenRequests,
          }),
        })
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
        return await finish({
          status: 'timeout',
          stopReason: 'timeout',
          finalResponse,
          ...(verification ? { verification } : {}),
          metrics: this.metrics(executor, {
            turns,
            modelRequests,
            inputTokens,
            outputTokens,
            measuredTokenRequests,
          }),
        })
      }

      if (state.state === 'RUNNING' || state.state === 'MODEL_PROPOSED_COMPLETE') {
        state.transition('FAILED')
      }

      return await finish({
        status: 'agent_error',
        stopReason: error instanceof Error ? error.message : 'agent_error',
        finalResponse,
        ...(verification ? { verification } : {}),
        metrics: this.metrics(executor, {
          turns,
          modelRequests,
          inputTokens,
          outputTokens,
          measuredTokenRequests,
        }),
      })
    }
  }

  private metrics(
    executor: ToolExecutor,
    parts: {
      turns: number
      modelRequests: number
      inputTokens: number
      outputTokens: number
      measuredTokenRequests: number
    },
  ) {
    const tool = executor.metrics
    return emptyMetrics({
      turns: parts.turns,
      modelRequests: parts.modelRequests,
      toolCalls: tool.toolCalls,
      toolFailures: tool.toolFailures,
      inputTokens: parts.inputTokens,
      outputTokens: parts.outputTokens,
      tokenUsage: {
        status:
          parts.modelRequests === 0 || parts.measuredTokenRequests === 0
            ? 'unavailable'
            : parts.measuredTokenRequests === parts.modelRequests
              ? 'complete'
              : 'partial',
        measuredRequests: parts.measuredTokenRequests,
        totalRequests: parts.modelRequests,
      },
    })
  }

  private async finish(context: AgentRunContext, result: AgentRunResult): Promise<AgentRunResult> {
    await context.eventSink
      .emit('agent', 'agent.completed', {
        status: result.status,
        stopReason: result.stopReason,
        metrics: result.metrics,
      })
      .catch(() => undefined)
    return result
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

  private isToolAllowedBySkill(toolName: string, context: AgentRunContext): boolean {
    const skill = context.skills?.find((item) => item.name === context.activeSkill)
    return !skill || skill.allowedTools.length === 0 || skill.allowedTools.includes(toolName)
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableSerialize(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nested) =>
      nested && typeof nested === 'object' && !Array.isArray(nested)
        ? Object.fromEntries(
            Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : nested,
    )
  } catch {
    return String(value)
  }
}

function redactCompletionCheck(
  check: NonNullable<AgentRunResult['verification']>,
  redactor: SecretRedactor,
): NonNullable<AgentRunResult['verification']> {
  return {
    ...check,
    message: redactor.redact(check.message),
    evidence: check.evidence.map((item) => redactor.redact(item)),
    stepResults: check.stepResults?.map((step) => ({
      ...step,
      message: redactor.redact(step.message),
      evidence: step.evidence.map((item) => redactor.redact(item)),
    })),
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

/** 判断重复工具调用的签名窗口与熔断阈值。 */
const RECENT_TOOL_CALL_WINDOW = 10
const REPEATED_TOOL_CALL_LIMIT = 3

async function delayWithAbort(signal: AbortSignal | undefined, ms: number): Promise<void> {
  await delay(ms, undefined, { signal })
}
