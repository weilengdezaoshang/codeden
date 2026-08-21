import type { TaskSpec } from '../../core/task/task-spec.js'
import type { AgentWorkspaceView } from '../../eval/ports/agent.port.js'
import type { BaselineSnapshot } from './baseline-snapshot.js'
import { verifyDiffPolicy } from './diff-policy-verifier.js'
import { verifyRegression } from './regression-verifier.js'
import { mergeChecks, type CompletionCheck } from './verification-result.js'

export interface CompletionVerifier {
  verify(taskSpec: TaskSpec, workspace: AgentWorkspaceView): Promise<CompletionCheck>
}

export class DefaultCompletionVerifier implements CompletionVerifier {
  constructor(private readonly baseline?: BaselineSnapshot) {}

  async verify(taskSpec: TaskSpec, workspace: AgentWorkspaceView): Promise<CompletionCheck> {
    const changed = await workspace.changedPaths()
    const diff = verifyDiffPolicy(taskSpec, changed)
    const regression = await verifyRegression(taskSpec, workspace, this.baseline)
    return mergeChecks([diff, regression])
  }
}
