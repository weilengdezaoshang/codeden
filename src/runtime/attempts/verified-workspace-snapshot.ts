import { z } from 'zod'
import { parseWithSchema } from '../../core/errors/codeden-error.js'
import type { TaskSpec } from '../../core/task/task-spec.js'
import type { AgentWorkspaceView } from '../../eval/ports/agent.port.js'
import type { CompletionVerifier } from '../verification/completion-verifier.js'
import type { CompletionCheck } from '../verification/verification-result.js'
import {
  captureWorkspaceRevision,
  parseWorkspaceRevision,
  WorkspaceRevisionSchema,
} from './workspace-revision.js'

export const VerifiedWorkspaceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: z.string().min(1),
  taskSpecId: z.string().min(1),
  revision: WorkspaceRevisionSchema,
  verifiedAt: z.iso.datetime(),
})

export type VerifiedWorkspaceSnapshot = z.infer<typeof VerifiedWorkspaceSnapshotSchema>

export async function createVerifiedWorkspaceSnapshot(input: {
  attemptId: string
  taskSpecId: string
  workspace: AgentWorkspaceView
  baseCommit?: string
  now?: Date
}): Promise<VerifiedWorkspaceSnapshot> {
  const changedPaths = await input.workspace.changedPaths()
  const revision = await captureWorkspaceRevision({
    root: input.workspace.root,
    changedPaths,
    baseCommit: input.baseCommit,
  })
  return parseVerifiedWorkspaceSnapshot({
    schemaVersion: 1,
    attemptId: input.attemptId,
    taskSpecId: input.taskSpecId,
    revision,
    verifiedAt: (input.now ?? new Date()).toISOString(),
  })
}

export function parseVerifiedWorkspaceSnapshot(input: unknown): VerifiedWorkspaceSnapshot {
  const snapshot = parseWithSchema(
    VerifiedWorkspaceSnapshotSchema,
    input,
    'Invalid verified workspace snapshot',
  )
  return { ...snapshot, revision: parseWorkspaceRevision(snapshot.revision) }
}

/** Adds an immutable workspace revision to successful completion checks. */
export class RevisionBoundCompletionVerifier implements CompletionVerifier {
  constructor(
    private readonly delegate: CompletionVerifier,
    private readonly options: { attemptId: string; baseCommit?: string },
  ) {}

  async verify(taskSpec: TaskSpec, workspace: AgentWorkspaceView): Promise<CompletionCheck> {
    const check = await this.delegate.verify(taskSpec, workspace)
    if (!check.passed) {
      return check
    }
    const verifiedSnapshot = await createVerifiedWorkspaceSnapshot({
      attemptId: this.options.attemptId,
      taskSpecId: taskSpec.id,
      workspace,
      baseCommit: this.options.baseCommit,
    })
    return { ...check, verifiedSnapshot }
  }
}
