import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TemporaryWorkspaceAdapter } from './temporary-workspace.js'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { SecretLeakGuard } from '@codeden/core/security/secret-leak-guard.js'
import type { SecretRedactor } from '@codeden/core/security/secret-redactor.js'
import { applyWorkspaceChanges } from './writeback-coordinator.js'
import { digestFile, type FileDigest } from './apply-plan.js'
import { detectGit, gitExec, hasGitMetadata, removeWorktree } from './git-repository.js'
import type { RunCommandOptions } from '../tools/builtins/run-command.js'
import { createSandboxRunner } from '../sandbox/sandbox-runner-factory.js'
import type { VerifiedWorkspaceSnapshot } from '../attempts/verified-workspace-snapshot.js'
import { WritebackGate } from './writeback-gate.js'

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
  private readonly baseCommit: string | undefined
  private readonly baselineDigests = new Map<string, FileDigest>()
  private disposed = false
  private readonly writebackGate = new WritebackGate()

  private constructor(input: {
    originRoot: string
    isolated: boolean
    workspace: TemporaryWorkspaceAdapter
    worktreeRoot?: string
    toplevel?: string
    redactor?: SecretRedactor
    guard?: SecretLeakGuard
    baseCommit?: string
  }) {
    this.originRoot = input.originRoot
    this.isolated = input.isolated
    this.workspace = input.workspace
    this.worktreeRoot = input.worktreeRoot
    this.toplevel = input.toplevel
    this.redactor = input.redactor
    this.guard = input.guard
    this.baseCommit = input.baseCommit
  }

  get baseRevision(): string | undefined {
    return this.baseCommit
  }

  static async open(
    originRoot: string,
    security: { redactor?: SecretRedactor; guard?: SecretLeakGuard } = {},
    commandOptions?: RunCommandOptions,
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
      return GitWorktreeSession.inplace(
        resolvedOrigin,
        commandOptions,
        security.redactor ? (value) => security.redactor!.redact(value) : undefined,
      )
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'codeden-wt-'))
    await rm(dir, { recursive: true, force: true })
    let baseCommit: string
    try {
      baseCommit = (await gitExec(git.toplevel, ['rev-parse', 'HEAD'])).trim()
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
    const sandboxRunner = createSandboxRunner(commandOptions)
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
        sandboxRunner,
        sandboxRedact: security.redactor ? (value) => security.redactor!.redact(value) : undefined,
      })
      return new GitWorktreeSession({
        originRoot: resolvedOrigin,
        isolated: true,
        workspace,
        worktreeRoot,
        toplevel: git.toplevel,
        redactor: security.redactor,
        guard: security.guard,
        baseCommit,
      })
    } catch (error) {
      await sandboxRunner?.dispose().catch(() => undefined)
      await removeWorktree(git.toplevel, worktreeRoot).catch(() => undefined)
      throw new CodeDenError({
        code: ErrorCodes.WORKSPACE_SETUP_FAILED,
        category: 'infrastructure',
        message: `Failed to initialize isolated workspace: ${error instanceof Error ? error.message : 'unknown error'}`,
        retryable: false,
      })
    }
  }

  async applyToOrigin(changedPaths: string[]): Promise<ApplyResult> {
    return this.applyPaths(changedPaths)
  }

  async applyVerifiedSnapshot(snapshot: VerifiedWorkspaceSnapshot): Promise<ApplyResult> {
    await this.writebackGate.assertCurrent(snapshot, this.workspace, {
      baseCommit: this.baseCommit,
    })
    const changedPaths = snapshot.revision.files.map((file) => file.path)
    const expectedCandidateDigests = new Map(
      snapshot.revision.files.map((file) => [file.path, file] as const),
    )
    return this.applyPaths(changedPaths, expectedCandidateDigests)
  }

  private async applyPaths(
    changedPaths: string[],
    expectedCandidateDigests?: ReadonlyMap<string, FileDigest>,
  ): Promise<ApplyResult> {
    if (!this.isolated) {
      return { applied: [...changedPaths].sort(), unchanged: [], conflicts: [] }
    }
    const result = await applyWorkspaceChanges({
      originRoot: this.originRoot,
      workspaceRoot: this.workspace.root,
      toplevel: this.toplevel ?? this.originRoot,
      changedPaths,
      baseRef: this.baseCommit,
      baselineDigests: this.baselineDigests,
      ...(expectedCandidateDigests ? { expectedCandidateDigests } : {}),
      redactor: this.redactor,
      guard: this.guard,
    })
    for (const rel of result.applied) {
      const posix = rel.replaceAll('\\', '/')
      this.baselineDigests.set(posix, await digestFile(path.join(this.originRoot, posix), posix))
    }
    return result
  }

  async discardChanges(): Promise<boolean> {
    if (!this.isolated) {
      return false
    }
    await gitExec(this.workspace.root, ['restore', '--worktree', '--staged', '--', '.'])
    await gitExec(this.workspace.root, ['clean', '-fd', '--', '.'])
    await this.workspace.refreshSnapshot()
    return true
  }

  async refreshSnapshot(): Promise<void> {
    await this.workspace.refreshSnapshot()
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
    let cleanupError: unknown
    try {
      await this.workspace.dispose()
    } catch (error) {
      cleanupError = error
    }
    if (!this.isolated || !this.worktreeRoot || !this.toplevel) {
      if (cleanupError) {
        throw cleanupError
      }
      return
    }
    try {
      await removeWorktree(this.toplevel, this.worktreeRoot)
    } catch (error) {
      cleanupError ??= error
    }
    if (cleanupError) {
      throw cleanupError
    }
  }

  private static async inplace(
    originRoot: string,
    commandOptions?: RunCommandOptions,
    sandboxRedact?: (value: string) => string,
  ): Promise<GitWorktreeSession> {
    const sandboxRunner = createSandboxRunner(commandOptions)
    try {
      const workspace = await TemporaryWorkspaceAdapter.fromExisting(originRoot, {
        deleteOnDispose: false,
        sandboxRunner,
        sandboxRedact,
      })
      return new GitWorktreeSession({
        originRoot,
        isolated: false,
        workspace,
      })
    } catch (error) {
      await sandboxRunner?.dispose().catch(() => undefined)
      throw error
    }
  }
}
