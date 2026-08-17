import type { AgentSubmission } from '../domain/agent-submission.js'
import type { GraderResult } from '../domain/verification-result.js'
import type { WorkspacePort } from '../ports/workspace.port.js'

export interface GraderContext {
  workspace: WorkspacePort
  submission?: AgentSubmission
}

export interface Grader<TConfig = unknown> {
  readonly type: string
  grade(config: TConfig, context: GraderContext): Promise<GraderResult>
}
