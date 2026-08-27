import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TemporaryWorkspaceAdapter } from '../../eval/adapters/workspaces/temporary-workspace.adapter.js'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import type { SecretLeakGuard } from '../../security/secret-leak-guard.js'
import type { SecretRedactor } from '../../security/secret-redactor.js'
import { applyWorkspaceChanges } from './writeback-coordinator.js'
import { detectGit, gitExec, hasGitMetadata, removeWorktree } from './git-repository.js'

export interface ApplyResult {
  applied: string[]
  unchanged: string[]
  conflicts: string[]
  patchPath?: string
}

export class GitWorktreeSession {
  readonly originRoot: string
  readonly isolated: boolean
  readonly workspace: TemporaryWorkspaceAdapter
  readonly worktreeRoot: string | undefined
  private readonly toplevel: string | undefined
  private readonly redactor: SecretRedactor | undefined
  private readonly guard: SecretLeakGuard | undefined
  private disposed = false

  private constructor(input: {
    originRoot: string
    isolated: boolean
    workspace: TemporaryWorkspaceAdapter
    worktreeRoot?: string
    toplevel?: string
    redactor?: SecretRedactor
    guard?: SecretLeakGuard
  }) {
    this.originRoot = input.originRoot
    this.isolated = input.isolated
    this.workspace = input.workspace
    this.worktreeRoot = input.worktreeRoot
    this.toplevel = input.toplevel
    this.redactor = input.redactor
    this.guard = input.guard
  }

  static async open(
    originRoot: string,
    security: { redactor?: SecretRedactor; guard?: SecretLeakGuard } = {},
  ): Promise<GitWorktreeSession> {
    const resolvedOrigin = await realpath(path.resolve(originRoot))
    const git = await detectGit(resolvedOrigin)
    if (!git) {
      if (await hasGitMetadata(resolvedOrigin)) {
        throw new CodeDenError({
          code: ErrorCodes.WORKSPACE_SETUP_FAILED,
          category: 'infrastructure',
          message: 'Git repository detected but isolation could not be established',
          retryable: false,
        })
      }
      return GitWorktreeSession.inplace(resolvedOrigin)
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'codeden-wt-'))
    await rm(dir, { recursive: true, force: true })
    try {
      await gitExec(git.toplevel, ['worktree', 'add', '--detach', dir, 'HEAD'])
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw new CodeDenError({
        code: ErrorCodes.WORKSPACE_SETUP_FAILED,
        category: 'infrastructure',
        message: `Failed to create isolated Git worktree: ${error instanceof Error ? error.message : 'unknown error'}`,
        retryable: false,
      })
    }

    const worktreeRoot = await realpath(dir)
    try {
      const rel = path.relative(git.toplevel, resolvedOrigin)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        await removeWorktree(git.toplevel, worktreeRoot)
        throw new CodeDenError({
          code: ErrorCodes.WORKSPACE_SETUP_FAILED,
          category: 'infrastructure',
          message: 'Workspace is outside the detected Git worktree',
          retryable: false,
        })
      }
      const agentRoot = rel === '' ? worktreeRoot : path.join(worktreeRoot, rel)
      await mkdir(agentRoot, { recursive: true })
      const workspace = await TemporaryWorkspaceAdapter.fromExisting(agentRoot, {
        deleteOnDispose: false,
      })
      return new GitWorktreeSession({
        originRoot: resolvedOrigin,
        isolated: true,
        workspace,
        worktreeRoot,
        toplevel: git.toplevel,
        redactor: security.redactor,
        guard: security.guard,
      })
    } catch (error) {
      await removeWorktree(git.toplevel, worktreeRoot)
      throw new CodeDenError({
        code: ErrorCodes.WORKSPACE_SETUP_FAILED,
        category: 'infrastructure',
        message: `Failed to initialize isolated workspace: ${error instanceof Error ? error.message : 'unknown error'}`,
        retryable: false,
      })
    }
  }

  async applyToOrigin(changedPaths: string[]): Promise<ApplyResult> {
    if (!this.isolated) {
      return { applied: [...changedPaths].sort(), unchanged: [], conflicts: [] }
    }
    return applyWorkspaceChanges({
      originRoot: this.originRoot,
      workspaceRoot: this.workspace.root,
      toplevel: this.toplevel ?? this.originRoot,
      changedPaths,
      redactor: this.redactor,
      guard: this.guard,
    })
  }

  async discardPatch(): Promise<void> {
    // A failed run must not delete a conflict Patch produced by a previous run.
    // A successful clean apply removes the latest pointer in writeConflictPatch.
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    await this.workspace.dispose()
    if (!this.isolated || !this.worktreeRoot || !this.toplevel) {
      return
    }
    await removeWorktree(this.toplevel, this.worktreeRoot)
  }

  private static async inplace(originRoot: string): Promise<GitWorktreeSession> {
    const workspace = await TemporaryWorkspaceAdapter.fromExisting(originRoot, {
      deleteOnDispose: false,
    })
    return new GitWorktreeSession({
      originRoot,
      isolated: false,
      workspace,
    })
  }
}
