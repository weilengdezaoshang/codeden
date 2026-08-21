import type { Clock } from '../../core/clock.js'
import { SystemClock } from '../../core/clock.js'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import type { EventSink } from '../../core/events/event-sink.js'
import { createId } from '../../core/ids.js'
import type { AgentSubmission } from '../domain/agent-submission.js'
import type { EvalCase } from '../domain/eval-case.js'
import { emptyMetrics, type TrialMetrics } from '../domain/metrics.js'
import type { TrialExecutionStatus, TrialResult } from '../domain/trial-result.js'
import type { VerificationResult } from '../domain/verification-result.js'
import type { AgentPort, AgentRunResult } from '../ports/agent.port.js'
import type { BenchmarkPort } from '../ports/benchmark.port.js'
import type { EvalRepository } from '../ports/eval-repository.port.js'
import { SecureEventSink } from '../../security/secure-event-sink.js'
import { createSecurityServices, type SecurityServices } from '../../security/security-services.js'
import type { WorkspaceFactory, WorkspacePort } from '../ports/workspace.port.js'
import { EventRecorder } from './event-recorder.js'

export interface RunTrialInput {
  runId: string
  evalCase: EvalCase
}

export interface TrialRunnerDeps {
  agent: AgentPort
  benchmark: BenchmarkPort
  workspaceFactory: WorkspaceFactory
  repository: EvalRepository
  clock?: Clock
  security?: SecurityServices
}

export class TrialRunner {
  private readonly agent: AgentPort
  private readonly benchmark: BenchmarkPort
  private readonly workspaceFactory: WorkspaceFactory
  private readonly repository: EvalRepository
  private readonly clock: Clock
  private readonly security: SecurityServices

  constructor(deps: TrialRunnerDeps) {
    this.agent = deps.agent
    this.benchmark = deps.benchmark
    this.workspaceFactory = deps.workspaceFactory
    this.repository = deps.repository
    this.clock = deps.clock ?? new SystemClock()
    this.security = deps.security ?? createSecurityServices()
  }

  async run(input: RunTrialInput): Promise<TrialResult> {
    const trialId = createId()
    const recorder = new EventRecorder(this.repository, input.runId, trialId, this.clock)
    const sink = new SecureEventSink(recorder, this.security.redactor, this.security.guard)
    const started = this.clock.monotonicMs()
    let workspace: WorkspacePort | undefined
    let infrastructure: TrialResult['infrastructure']['status'] = 'ok'
    let agentResult: AgentRunResult | undefined
    let submissionStatus: TrialResult['submission']['status'] = 'missing'
    let verification: VerificationResult = {
      status: 'error',
      scores: {},
      graderResults: [],
      message: 'Verification was not run',
    }

    try {
      await sink.emit('eval', 'eval.trial.started', { caseId: input.evalCase.id })

      try {
        workspace = await this.workspaceFactory.create(input.evalCase.fixture)
      } catch (error) {
        infrastructure = 'setup_error'
        throw wrapSetup(error)
      }

      await sink.emit('workspace', 'workspace.prepared', { root: workspace.root })
      const prepared = await this.benchmark.prepare(input.evalCase, workspace)

      try {
        agentResult = await this.runAgent(prepared.agentTask, {
          runId: input.runId,
          trialId,
          workspace,
          eventSink: sink,
          limits: {
            maxTurns: input.evalCase.limits.maxTurns,
            maxToolCalls: input.evalCase.limits.maxToolCalls,
          },
          submissionType: input.evalCase.submission.type,
          allowedPaths: input.evalCase.task.taskSpec.allowedPaths,
          timeoutMs: input.evalCase.limits.timeoutMs,
        })
      } catch (error) {
        if (isCode(error, ErrorCodes.AGENT_TIMEOUT)) {
          agentResult = timeoutResult()
        } else {
          throw error
        }
      }

      submissionStatus = validateSubmission(agentResult.submission, input.evalCase.submission.type)

      if (agentResult.status === 'timeout') {
        verification = {
          status: 'error',
          scores: {},
          graderResults: [],
          message: 'Verification skipped because the agent timed out',
        }
      } else if (submissionStatus === 'missing' && input.evalCase.submission.type === 'text') {
        verification = {
          status: 'failed',
          scores: {},
          graderResults: [],
          message: 'Submission missing',
        }
      } else {
        await sink.emit('verifier', 'verification.started', {})
        try {
          verification = await this.benchmark.verify(prepared, agentResult.submission, {
            workspace,
            runId: input.runId,
            trialId,
          })
          await sink.emit('verifier', 'verification.completed', verification)
        } catch (error) {
          await sink.emit('verifier', 'verification.failed', { error: toErrorMessage(error) })
          verification = {
            status: 'error',
            scores: {},
            graderResults: [],
            message: toErrorMessage(error),
          }
        }
      }

      return await this.persist(
        buildTrialResult({
          runId: input.runId,
          trialId,
          caseId: input.evalCase.id,
          benchmark: input.evalCase.metadata
            ? {
                name: input.evalCase.metadata.source,
                version: input.evalCase.metadata.version,
                upstreamId: input.evalCase.metadata.upstreamId,
                license: input.evalCase.metadata.license,
                sha256: input.evalCase.metadata.sha256,
                verificationMode: input.evalCase.metadata.verificationMode,
              }
            : undefined,
          agentResult,
          submissionStatus,
          verification,
          infrastructure,
          durationMs: Math.max(0, this.clock.monotonicMs() - started),
        }),
      )
    } catch (error) {
      const mapped = mapFailureToTrialResult({
        error,
        runId: input.runId,
        trialId,
        caseId: input.evalCase.id,
        benchmark: input.evalCase.metadata
          ? {
              name: input.evalCase.metadata.source,
              version: input.evalCase.metadata.version,
              upstreamId: input.evalCase.metadata.upstreamId,
              license: input.evalCase.metadata.license,
              sha256: input.evalCase.metadata.sha256,
              verificationMode: input.evalCase.metadata.verificationMode,
            }
          : undefined,
        agentResult,
        submissionStatus,
        verification,
        infrastructure,
        durationMs: Math.max(0, this.clock.monotonicMs() - started),
      })
      return await this.persist(mapped)
    } finally {
      try {
        if (workspace) {
          await workspace.dispose()
          await sink.emit('workspace', 'workspace.disposed', {})
        }
        await sink.emit('eval', 'eval.trial.completed', { caseId: input.evalCase.id })
      } catch {
        // Dispose/event failures must not hide a persisted TrialResult.
      }
    }
  }

  private async persist(result: TrialResult): Promise<TrialResult> {
    const safe = this.security.redactor.redactValue(result) as TrialResult
    this.security.guard.assertSafe(safe, `trial:${result.trialId}`)
    await this.repository.saveTrial(safe)
    return safe
  }

  private async runAgent(
    task: Parameters<AgentPort['run']>[0],
    options: {
      runId: string
      trialId: string
      workspace: WorkspacePort
      eventSink: EventSink
      limits: { maxTurns: number; maxToolCalls: number }
      submissionType: 'files' | 'text'
      allowedPaths: string[]
      timeoutMs: number
    },
  ): Promise<AgentRunResult> {
    const controller = new AbortController()
    const timeoutError = new CodeDenError({
      code: ErrorCodes.AGENT_TIMEOUT,
      category: 'timeout',
      message: `Agent exceeded timeout of ${options.timeoutMs}ms`,
      retryable: false,
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const runPromise = this.agent.run(task, {
      runId: options.runId,
      trialId: options.trialId,
      workspace: options.workspace,
      eventSink: options.eventSink,
      abortSignal: controller.signal,
      limits: options.limits,
      submissionType: options.submissionType,
      allowedPaths: options.allowedPaths,
    })

    try {
      return await Promise.race([
        runPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(timeoutError)
          }, options.timeoutMs)
        }),
      ])
    } catch (error) {
      if (isCode(error, ErrorCodes.AGENT_TIMEOUT)) {
        const settled = await Promise.race([
          runPromise.then(
            (result) => result,
            () => undefined,
          ),
          new Promise<undefined>((resolve) => {
            setTimeout(() => resolve(undefined), 50)
          }),
        ])
        if (settled) {
          return settled.status === 'timeout'
            ? settled
            : { ...settled, status: 'timeout', stopReason: settled.stopReason ?? 'timeout' }
        }
      }
      throw error
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}

function validateSubmission(
  submission: AgentSubmission | undefined,
  expected: 'files' | 'text',
): TrialResult['submission']['status'] {
  if (!submission) {
    return 'missing'
  }
  if (submission.type !== expected) {
    return 'invalid'
  }
  if (submission.type === 'files' && submission.changedPaths.length === 0) {
    return 'empty'
  }
  if (submission.type === 'text' && submission.content.trim() === '') {
    return 'empty'
  }
  return 'valid'
}

function buildTrialResult(input: {
  runId: string
  trialId: string
  caseId: string
  benchmark?: TrialResult['benchmark']
  agentResult: AgentRunResult
  submissionStatus: TrialResult['submission']['status']
  verification: VerificationResult
  infrastructure: TrialResult['infrastructure']['status']
  durationMs: number
}): TrialResult {
  return {
    schemaVersion: 1,
    runId: input.runId,
    trialId: input.trialId,
    caseId: input.caseId,
    benchmark: input.benchmark,
    execution: {
      status: toExecutionStatus(input.agentResult.status),
      ...(input.agentResult.stopReason ? { stopReason: input.agentResult.stopReason } : {}),
    },
    submission: { status: input.submissionStatus },
    verification: { status: input.verification.status },
    infrastructure: { status: input.infrastructure },
    resolved: input.verification.status === 'passed',
    scores: input.verification.scores,
    metrics: withDuration(input.agentResult.metrics, input.durationMs),
    artifacts: [],
  }
}

function mapFailureToTrialResult(input: {
  error: unknown
  runId: string
  trialId: string
  caseId: string
  benchmark?: TrialResult['benchmark']
  agentResult: AgentRunResult | undefined
  submissionStatus: TrialResult['submission']['status']
  verification: VerificationResult
  infrastructure: TrialResult['infrastructure']['status']
  durationMs: number
}): TrialResult {
  const setupFailed = isCode(input.error, ErrorCodes.WORKSPACE_SETUP_FAILED)
  const executionStatus: TrialExecutionStatus = input.agentResult
    ? toExecutionStatus(input.agentResult.status)
    : 'agent_error'
  return {
    schemaVersion: 1,
    runId: input.runId,
    trialId: input.trialId,
    caseId: input.caseId,
    benchmark: input.benchmark,
    execution: {
      status: executionStatus,
      stopReason: toErrorMessage(input.error),
    },
    submission: { status: input.submissionStatus },
    verification: { status: input.verification.status },
    infrastructure: {
      status: setupFailed
        ? 'setup_error'
        : input.infrastructure === 'ok'
          ? 'runtime_error'
          : input.infrastructure,
    },
    resolved: false,
    scores: {},
    metrics: withDuration(input.agentResult?.metrics ?? emptyMetrics(), input.durationMs),
    artifacts: [],
  }
}

function withDuration(metrics: TrialMetrics, durationMs: number): TrialMetrics {
  return { ...metrics, durationMs }
}

function toExecutionStatus(status: AgentRunResult['status']): TrialExecutionStatus {
  return status === 'verified_complete' ? 'submitted' : status
}

function timeoutResult(): AgentRunResult {
  return {
    status: 'timeout',
    stopReason: 'timeout',
    finalResponse: '',
    metrics: emptyMetrics(),
  }
}

function wrapSetup(error: unknown): CodeDenError {
  if (isCode(error, ErrorCodes.WORKSPACE_SETUP_FAILED)) {
    return error as CodeDenError
  }
  return new CodeDenError({
    code: ErrorCodes.WORKSPACE_SETUP_FAILED,
    category: 'infrastructure',
    message: toErrorMessage(error),
    retryable: false,
  })
}

function isCode(error: unknown, code: string): boolean {
  return CodeDenError.isCodeDenError(error) && error.code === code
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
