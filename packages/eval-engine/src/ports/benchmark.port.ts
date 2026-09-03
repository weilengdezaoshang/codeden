import type { AgentSubmission } from '@codeden/core/agent-submission.js'
import type { EvalCase } from '../domain/eval-case.js'
import type { VerificationResult } from '../domain/verification-result.js'
import type { AgentTask } from '@codeden/agent-runtime/agent/agent-contracts.js'
import type { AgentRunResult } from '@codeden/agent-runtime/agent/agent-contracts.js'
import type { WorkspacePort } from '@codeden/core/workspace/workspace-contracts.js'

export interface BenchmarkSource {
  kind: 'file' | 'directory'
  path: string
}

export interface PreparedCase {
  evalCase: EvalCase
  agentTask: AgentTask
  workspace: WorkspacePort
}

export interface VerificationContext {
  workspace: WorkspacePort
  runId: string
  trialId: string
  agentResult?: AgentRunResult
  onStage?(stage: VerificationStage): Promise<void>
}

export interface VerificationStage {
  name:
    | 'patch_generation'
    | 'prediction_write'
    | 'harness_execution'
    | 'report_read'
    | 'result_classification'
  status: 'started' | 'completed' | 'failed'
  message?: string
}

export interface BenchmarkPort {
  readonly name: string
  load(source: BenchmarkSource): AsyncIterable<EvalCase>
  prepare(evalCase: EvalCase, workspace: WorkspacePort): Promise<PreparedCase>
  verify(
    preparedCase: PreparedCase,
    submission: AgentSubmission | undefined,
    context: VerificationContext,
  ): Promise<VerificationResult>
}
