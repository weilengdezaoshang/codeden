import type { AgentSubmission } from '@codeden/core/agent-submission.js'
import type { TrialMetrics } from '@codeden/core/metrics.js'
import type { GraderResult } from '../domain/verification-result.js'
import type { WorkspacePort } from '@codeden/core/workspace/workspace-contracts.js'

export interface GraderContext {
  workspace: WorkspacePort
  submission?: AgentSubmission
  finalResponse?: string
  metrics?: TrialMetrics
}

export interface Grader<TConfig = unknown> {
  readonly type: string
  grade(config: TConfig, context: GraderContext): Promise<GraderResult>
}
