import type { TaskSpec } from '../../core/task/task-spec.js'
import type { AgentWorkspaceView } from '../../eval/ports/agent.port.js'
import { verifyCommands } from './command-verifier.js'
import { verifyDiffPolicy } from './diff-policy-verifier.js'
import { mergeChecks, type CompletionCheck } from './verification-result.js'

export interface CompletionVerifier {
  verify(taskSpec: TaskSpec, workspace: AgentWorkspaceView): Promise<CompletionCheck>
}

export class DefaultCompletionVerifier implements CompletionVerifier {
  async verify(taskSpec: TaskSpec, workspace: AgentWorkspaceView): Promise<CompletionCheck> {
    const changed = await workspace.changedPaths()
    const diff = verifyDiffPolicy(taskSpec, changed)
    const exec = workspace.exec
    if (!exec) {
      if (taskSpec.verificationCommands.length > 0) {
        return {
          passed: false,
          message: 'Workspace cannot execute verification commands',
          evidence: taskSpec.verificationCommands,
        }
      }
      return diff
    }
    const commands = await verifyCommands(taskSpec, (command) => exec(command))
    return mergeChecks([diff, commands])
  }
}
