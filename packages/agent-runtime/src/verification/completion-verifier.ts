import type { TaskSpec } from '@codeden/core/task/task-spec.js'
import type { AgentWorkspaceView } from '../agent/agent-contracts.js'
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
    const diff = withDiffStep(taskSpec, verifyDiffPolicy(taskSpec, changed))
    if (!diff.passed) {
      return diff
    }
    const regression = await verifyRegression(taskSpec, workspace, this.baseline)
    const finalDiff = withDiffStep(
      taskSpec,
      verifyDiffPolicy(taskSpec, await workspace.changedPaths()),
    )
    return mergeChecks([regression, finalDiff])
  }
}

function withDiffStep(taskSpec: TaskSpec, check: CompletionCheck): CompletionCheck {
  const step = taskSpec.verificationPlan.steps.find((item) => item.kind === 'diff')
  return {
    ...check,
    stepResults: [
      {
        stepId: step?.id ?? 'workspace-diff',
        kind: 'diff',
        status: check.passed ? 'passed' : 'failed',
        required: step?.required ?? true,
        durationMs: 0,
        message: check.message,
        evidence: check.evidence,
      },
    ],
  }
}
