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
import { InMemorySecretRegistry } from '../../security/secret-registry.js'
import { SecretRedactor } from '../../security/secret-redactor.js'
import type { ModelProvider } from '../models/model-provider.js'
import type { ModelResponse } from '../models/model-types.js'
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
  }

  async run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult> {
    const state = new AgentStateMachine()
    state.transition('RUNNING')
    await context.eventSink.emit('agent', 'agent.started', {
      taskId: task.taskSpec.id,
      prompt: task.prompt,
      taskSpec: task.taskSpec,
    })

    const allowedPaths = context.allowedPaths ?? task.taskSpec.allowedPaths
    const scopedContext: AgentRunContext = { ...context, allowedPaths }
    const completionVerifier = scopedContext.completionVerifier ?? this.verifier
    const executor = this.createExecutor(scopedContext)
    const researchDecision = this.researchPolicy.assess(task.prompt)
    let researchRequired = researchDecision.level === 'required'
    const searchAvailable = this.toolsEnabled && Boolean(this.registry.get('search_docs'))
    const fetchAvailable = this.toolsEnabled && Boolean(this.registry.get('fetch_url'))
    const researchAvailable = searchAvailable || fetchAvailable
    const instructions = await this.instructionLoader.loadHierarchy(scopedContext.workspace.root, {
      includeUser: true,
    })
    const instructionConflicts = diagnoseInstructionConflicts(instructions)
    await scopedContext.eventSink.emit('agent', 'agent.instructions_loaded', {
      files: instructions.map((instruction) => instruction.file),
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

    let turns = 0
    let modelRequests = 0
    let inputTokens = 0
    let outputTokens = 0
    let finalResponse = ''
    let stopReason: string | undefined
    let verifiedSnapshot: AgentRunResult['verifiedSnapshot']
    let verification: AgentRunResult['verification']

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
          }
          await scopedContext.eventSink.emit('model', 'model.requested', {
            turn: turns,
            messages: request.messages,
            tools: request.tools,
          })
          const onTextDelta = async (delta: string) => {
            if (!delta) {
              return
            }
            await scopedContext.eventSink.emit('model', 'model.text_delta', { delta })
            await scopedContext.onTextDelta?.(delta)
          }
          response = this.model.stream
            ? await this.model.stream(request, onTextDelta)
            : await this.model.complete(request)
          if (!this.model.stream && response.text) {
            await onTextDelta(response.text)
          }
        } catch (error) {
          await scopedContext.eventSink.emit('model', 'model.failed', { error: toErrorData(error) })
          throw error
        }

        inputTokens += response.usage.inputTokens
        outputTokens += response.usage.outputTokens
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

        for (const toolCall of response.toolCalls) {
          this.throwIfAborted(scopedContext)
          const result = await executor.execute(toolCall)
          if (!result.ok && this.researchPolicy.shouldEscalateAfterFailure(result.error.message)) {
            researchRequired = true
            messages.push({
              role: 'user',
              content:
                'The tool result indicates an unfamiliar or version-sensitive API. Treat this as a research trigger: inspect local types first, then use search_docs and fetch_url before continuing.',
            })
          }
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

      if (state.state === 'VERIFIED_COMPLETE' || state.state === 'MODEL_PROPOSED_COMPLETE') {
        const submission = await collectSubmission(scopedContext, finalResponse)
        if (state.state === 'MODEL_PROPOSED_COMPLETE') {
          state.transition('SUBMITTED')
        }
        await scopedContext.eventSink.emit('agent', 'agent.submitted', { submission })
        return {
          status: state.state === 'VERIFIED_COMPLETE' ? 'verified_complete' : 'submitted',
          stopReason,
          finalResponse,
          submission,
          ...(verifiedSnapshot ? { verifiedSnapshot } : {}),
          ...(verification ? { verification } : {}),
          metrics: this.metrics(executor, { turns, modelRequests, inputTokens, outputTokens }),
        }
      }

      if (state.state === 'BUDGET_EXHAUSTED') {
        const submission = await collectSubmission(scopedContext, finalResponse)
        return {
          status: 'budget_exhausted',
          stopReason: stopReason ?? 'budget_exhausted',
          finalResponse,
          submission,
          ...(verification ? { verification } : {}),
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
          ...(verification ? { verification } : {}),
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
        ...(verification ? { verification } : {}),
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

  private isToolAllowedBySkill(toolName: string, context: AgentRunContext): boolean {
    const skill = context.skills?.find((item) => item.name === context.activeSkill)
    return !skill || skill.allowedTools.length === 0 || skill.allowedTools.includes(toolName)
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
