import type { Clock } from '@codeden/core/clock.js'
import { SystemClock } from '@codeden/core/clock.js'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { EventSink } from '@codeden/core/events/event-sink.js'
import { createId } from '@codeden/core/ids.js'
import type { AgentSubmission } from '@codeden/core/agent-submission.js'
import type { EvalCase } from '../domain/eval-case.js'
import { emptyMetrics, type TrialMetrics } from '@codeden/core/metrics.js'
import type { TrialExecutionStatus, TrialResult } from '../domain/trial-result.js'
import type { VerificationResult } from '../domain/verification-result.js'
import type { AgentPort, AgentRunResult } from '@codeden/agent-runtime/agent/agent-contracts.js'
import type { BenchmarkPort } from '../ports/benchmark.port.js'
import type { EvalRepository } from '../ports/eval-repository.port.js'
import { SecureEventSink } from '@codeden/core/security/secure-event-sink.js'
import {
  createSecurityServices,
  type SecurityServices,
} from '@codeden/core/security/security-services.js'
import type {
  WorkspaceFactory,
  WorkspaceFileDiff,
  WorkspacePort,
} from '@codeden/core/workspace/workspace-contracts.js'
import { EventRecorder } from './event-recorder.js'
import { analyzeFailure } from '../analysis/failure-analyzer.js'
import { isTrialResolved } from '../domain/trial-result.js'
import { TrialMetricsSink } from './trial-metrics-sink.js'

export interface RunTrialInput {
  runId: string
  jobId?: string
  benchmarkRunId?: string
  evalCase: EvalCase
  signal?: AbortSignal
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
    const recorder = new EventRecorder(this.repository, input.runId, trialId, this.clock, {
      jobId: input.jobId,
      benchmarkRunId: input.benchmarkRunId,
    })
    const sink = new SecureEventSink(recorder, this.security.redactor, this.security.guard)
    const agentSink = new TrialMetricsSink(sink)
    const started = this.clock.monotonicMs()
    let workspace: WorkspacePort | undefined
    let infrastructure: TrialResult['infrastructure']['status'] = 'ok'
    let agentResult: AgentRunResult | undefined
    let diffs: WorkspaceFileDiff[] = []
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
        workspace = await this.workspaceFactory.create(input.evalCase.fixture, {
          signal: input.signal,
        })
      } catch (error) {
        infrastructure = 'setup_error'
        await sink.emit('workspace', 'workspace.setup_failed', {
          error: toErrorMessage(error),
          ...errorCause(error),
        })
        throw wrapSetup(error)
      }

      await sink.emit('workspace', 'workspace.prepared', { root: workspace.root })
      const prepared = await this.benchmark.prepare(input.evalCase, workspace)

      try {
        agentResult = await this.runAgent(prepared.agentTask, {
          runId: input.runId,
          trialId,
          workspace,
          eventSink: agentSink,
          limits: {
            maxTurns: input.evalCase.limits.maxTurns,
            maxToolCalls: input.evalCase.limits.maxToolCalls,
          },
          submissionType: input.evalCase.submission.type,
          allowedPaths: input.evalCase.task.taskSpec.allowedPaths,
          persona: input.evalCase.persona?.instruction,
          timeoutMs: input.evalCase.limits.timeoutMs,
        })
      } catch (error) {
        if (isCode(error, ErrorCodes.AGENT_TIMEOUT)) {
          agentResult = timeoutResult(agentSink.snapshot())
        } else {
          agentResult = { status: 'agent_error', finalResponse: '', metrics: agentSink.snapshot() }
          throw error
        }
      } finally {
        agentSink.close()
        if (workspace?.fileDiffs) {
          try {
            diffs = await workspace.fileDiffs()
          } catch {
            // Diff is diagnostic evidence and must not hide the Agent result.
          }
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
            agentResult,
            onStage: (stage) => sink.emit('verifier', 'verification.stage', stage),
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
          jobId: input.jobId,
          benchmarkRunId: input.benchmarkRunId,
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
          diffs,
          durationMs: Math.max(0, this.clock.monotonicMs() - started),
        }),
      )
    } catch (error) {
      const mapped = mapFailureToTrialResult({
        error,
        runId: input.runId,
        jobId: input.jobId,
        benchmarkRunId: input.benchmarkRunId,
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
        diffs,
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
    let enriched = result
    try {
      const analysis = analyzeFailure(
        result,
        await this.repository.getEvents(result.trialId, result.benchmarkRunId ?? result.runId),
      )
      if (analysis.category !== 'none') {
        enriched = {
          ...result,
          failure: {
            category: analysis.category,
            message: analysis.message,
            identities: [...analysis.identities],
            ...(analysis.fingerprint ? { fingerprint: analysis.fingerprint } : {}),
            evidence: [...analysis.evidence],
            diagnosis: analysis.diagnosis,
          },
        }
      }
    } catch {
      // Failure analysis is diagnostic and must not hide the primary trial result.
    }
    const safe = this.security.redactor.redactValue(enriched) as TrialResult
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
      persona?: string
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
      persona: options.persona,
      approvalMode: 'auto',
      includeUserInstructions: false,
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
  jobId?: string
  benchmarkRunId?: string
  trialId: string
  caseId: string
  benchmark?: TrialResult['benchmark']
  agentResult: AgentRunResult
  submissionStatus: TrialResult['submission']['status']
  verification: VerificationResult
  infrastructure: TrialResult['infrastructure']['status']
  diffs: WorkspaceFileDiff[]
  durationMs: number
}): TrialResult {
  return {
    schemaVersion: 1,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.benchmarkRunId ? { benchmarkRunId: input.benchmarkRunId } : {}),
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
    resolved: isTrialResolved({
      verification: input.verification,
      infrastructure: { status: input.infrastructure },
    }),
    scores: input.verification.scores,
    metrics: withDuration(input.agentResult.metrics, input.durationMs),
    diffs: input.diffs,
    artifacts: [],
  }
}

function mapFailureToTrialResult(input: {
  error: unknown
  runId: string
  jobId?: string
  benchmarkRunId?: string
  trialId: string
  caseId: string
  benchmark?: TrialResult['benchmark']
  agentResult: AgentRunResult | undefined
  submissionStatus: TrialResult['submission']['status']
  verification: VerificationResult
  infrastructure: TrialResult['infrastructure']['status']
  diffs: WorkspaceFileDiff[]
  durationMs: number
}): TrialResult {
  const setupFailed = isCode(input.error, ErrorCodes.WORKSPACE_SETUP_FAILED)
  const executionStatus: TrialExecutionStatus = input.agentResult
    ? toExecutionStatus(input.agentResult.status)
    : 'agent_error'
  return {
    schemaVersion: 1,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.benchmarkRunId ? { benchmarkRunId: input.benchmarkRunId } : {}),
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
    diffs: input.diffs,
    artifacts: [],
  }
}

function withDuration(metrics: TrialMetrics, durationMs: number): TrialMetrics {
  return { ...metrics, durationMs }
}

function toExecutionStatus(status: AgentRunResult['status']): TrialExecutionStatus {
  return status === 'verified_complete' ? 'submitted' : status
}

function timeoutResult(metrics: TrialMetrics): AgentRunResult {
  return {
    status: 'timeout',
    stopReason: 'timeout',
    finalResponse: '',
    metrics,
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

function errorCause(error: unknown): { cause?: string } {
  if (!CodeDenError.isCodeDenError(error) || !error.details || typeof error.details !== 'object') {
    return {}
  }
  const cause = (error.details as { cause?: unknown }).cause
  return typeof cause === 'string' && cause.length > 0 ? { cause } : {}
}
