import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { AgentWorkspaceView } from '../agent/agent-contracts.js'
import {
  parseVerifiedWorkspaceSnapshot,
  type VerifiedWorkspaceSnapshot,
} from '../attempts/verified-workspace-snapshot.js'
import { captureWorkspaceRevision, type WorkspaceRevision } from '../attempts/workspace-revision.js'

export class WritebackGate {
  async assertCurrent(
    inputSnapshot: VerifiedWorkspaceSnapshot,
    workspace: AgentWorkspaceView,
    options: { baseCommit?: string } = {},
  ): Promise<WorkspaceRevision> {
    const snapshot = parseVerifiedWorkspaceSnapshot(inputSnapshot)
    if (snapshot.revision.baseCommit !== options.baseCommit) {
      throw workspaceRevisionStale(
        snapshot.revision.baseCommit ?? '(none)',
        options.baseCommit ?? '(none)',
      )
    }
    const current = await captureWorkspaceRevision({
      root: workspace.root,
      changedPaths: await workspace.changedPaths(),
      baseCommit: options.baseCommit,
    })
    if (current.id !== snapshot.revision.id) {
      throw workspaceRevisionStale(snapshot.revision.id, current.id)
    }
    return current
  }
}

export function workspaceRevisionStale(
  expectedRevision: string,
  actualRevision: string,
): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.WORKSPACE_REVISION_STALE,
    category: 'workspace',
    message: '工作区在验证后已发生变化，需要重新验证后才能写回',
    retryable: true,
    details: { expectedRevision, actualRevision },
  })
}
