import type { AgentSubmission } from '../domain/agent-submission.js'
import type { EvalCase } from '../domain/eval-case.js'
import type { VerificationResult } from '../domain/verification-result.js'
import type { AgentTask } from './agent.port.js'
import type { WorkspacePort } from './workspace.port.js'

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
