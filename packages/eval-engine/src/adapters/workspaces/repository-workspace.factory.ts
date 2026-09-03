import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type {
  CommandSpec,
  WorkspaceFactory,
  WorkspaceCreateOptions,
  WorkspaceFixture,
  WorkspacePort,
} from '@codeden/core/workspace/workspace-contracts.js'
import type { RunCommandOptions } from '@codeden/agent-runtime/tools/builtins/run-command.js'
import { createSandboxRunner } from '@codeden/agent-runtime/sandbox/sandbox-runner-factory.js'
import {
  TemporaryWorkspaceAdapter,
  TemporaryWorkspaceFactory,
} from '@codeden/agent-runtime/workspace/temporary-workspace.js'

const execFileAsync = promisify(execFile)
const DEFAULT_REPOSITORY_SETUP_TIMEOUT_MS = 300_000
const DEFAULT_REPOSITORY_SETUP_CONCURRENCY = 2

export interface RepositoryWorkspaceFactoryOptions {
  allowVerificationCommands?: boolean
  resolveRepositoryUrl?: (repository: string) => string
  localFactory?: WorkspaceFactory
  commandOptions?: RunCommandOptions
  sandboxRedact?: (value: string) => string
  applyTestPatch?: boolean
  initializeCommand?: CommandSpec
  repositorySetupTimeoutMs?: number
}

export class RepositoryWorkspaceFactory implements WorkspaceFactory {
  private readonly allowVerificationCommands: boolean
  private readonly resolveRepositoryUrl: (repository: string) => string
  private readonly localFactory: WorkspaceFactory
  private readonly commandOptions: RunCommandOptions | undefined
  private readonly sandboxRedact: ((value: string) => string) | undefined
  private readonly applyTestPatch: boolean
  private readonly initializeCommand: CommandSpec | undefined
  private readonly repositorySetupTimeoutMs: number

  constructor(options: RepositoryWorkspaceFactoryOptions = {}) {
    this.allowVerificationCommands = options.allowVerificationCommands ?? false
    this.resolveRepositoryUrl =
      options.resolveRepositoryUrl ?? ((repository) => `https://github.com/${repository}.git`)
    this.localFactory =
      options.localFactory ??
      new TemporaryWorkspaceFactory(
        undefined,
        this.allowVerificationCommands,
        options.commandOptions,
        options.sandboxRedact,
      )
    this.commandOptions = options.commandOptions
    this.sandboxRedact = options.sandboxRedact
    this.applyTestPatch = options.applyTestPatch ?? true
    this.initializeCommand = options.initializeCommand
    this.repositorySetupTimeoutMs =
      options.repositorySetupTimeoutMs ??
      readPositiveInteger(
        process.env.CODEDEN_REPOSITORY_SETUP_TIMEOUT_MS,
        DEFAULT_REPOSITORY_SETUP_TIMEOUT_MS,
        'CODEDEN_REPOSITORY_SETUP_TIMEOUT_MS',
      )
    if (!Number.isInteger(this.repositorySetupTimeoutMs) || this.repositorySetupTimeoutMs < 1) {
      throw new Error('repositorySetupTimeoutMs 必须是正整数')
    }
  }

  async create(
    fixture: WorkspaceFixture,
    options: WorkspaceCreateOptions = {},
  ): Promise<WorkspacePort> {
    if (!fixture.repository) {
      return this.localFactory.create(fixture, options)
    }

    assertRepository(fixture.repository.repository)
    assertCommit(fixture.repository.baseCommit)
    const releaseSetupSlot = await repositorySetupLimiter.acquire(options.signal)
    let root: string | undefined
    let sandboxRunner: ReturnType<typeof createSandboxRunner> | undefined
    try {
      options.signal?.throwIfAborted()
      root = await mkdtemp(path.join(tmpdir(), 'codeden-repo-'))
      sandboxRunner = createSandboxRunner(this.commandOptions)
      const repositoryUrl = this.resolveRepositoryUrl(fixture.repository.repository)
      await git(['-C', root, 'init', '--quiet'], this.repositorySetupTimeoutMs, options.signal)
      await git(
        ['-C', root, 'remote', 'add', 'origin', repositoryUrl],
        this.repositorySetupTimeoutMs,
        options.signal,
      )
      await git(
        ['-C', root, 'fetch', '--no-tags', '--depth', '1', 'origin', fixture.repository.baseCommit],
        this.repositorySetupTimeoutMs,
        options.signal,
      )
      await git(
        ['-C', root, 'checkout', '--detach', 'FETCH_HEAD'],
        this.repositorySetupTimeoutMs,
        options.signal,
      )
      if (this.applyTestPatch && fixture.repository.testPatch.trim()) {
        const patchPath = path.join(root, '.codeden-test.patch')
        await writeFile(patchPath, fixture.repository.testPatch, 'utf8')
        try {
          await git(
            ['-C', root, 'apply', '--whitespace=nowarn', '--', patchPath],
            this.repositorySetupTimeoutMs,
            options.signal,
          )
        } finally {
          await rm(patchPath, { force: true })
        }
      }
      const workspace = await TemporaryWorkspaceAdapter.fromExisting(root, {
        deleteOnDispose: true,
        allowCommands: true,
        allowVerificationCommands: this.allowVerificationCommands,
        sandboxRunner,
        sandboxRedact: this.sandboxRedact,
      })
      if (this.initializeCommand) {
        const result = await workspace.exec(this.initializeCommand)
        if (result.exitCode !== 0) {
          throw new Error(`Workspace initialization failed: ${result.stderr || result.stdout}`)
        }
        await workspace.refreshSnapshot()
      }
      return workspace
    } catch (error) {
      await sandboxRunner?.dispose().catch(() => undefined)
      if (root) {
        await rm(root, { recursive: true, force: true })
      }
      throw new CodeDenError({
        code: ErrorCodes.WORKSPACE_SETUP_FAILED,
        category: 'infrastructure',
        message: 'Failed to prepare repository fixture',
        retryable: false,
        details: { cause: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      releaseSetupSlot()
    }
  }
}

async function git(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      signal?.throwIfAborted()
      await execFileAsync('git', args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal,
      })
      return
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error
      }
      lastError = error
      if (attempt === 0) {
        await delay(250)
      }
    }
  }
  throw lastError
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} 必须是正整数`)
  }
  return parsed
}

class AsyncSemaphore {
  private available: number
  private readonly waiters: Waiter[] = []

  constructor(concurrency: number) {
    this.available = concurrency
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    if (this.available > 0) {
      this.available -= 1
      return () => this.release()
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve(() => this.release())
        },
        reject,
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) {
          this.waiters.splice(index, 1)
        }
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next.grant()
    } else {
      this.available += 1
    }
  }
}

interface Waiter {
  grant: () => void
  reject: (reason?: unknown) => void
}

const repositorySetupLimiter = new AsyncSemaphore(
  readPositiveInteger(
    process.env.CODEDEN_REPOSITORY_SETUP_CONCURRENCY,
    DEFAULT_REPOSITORY_SETUP_CONCURRENCY,
    'CODEDEN_REPOSITORY_SETUP_CONCURRENCY',
  ),
)

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid repository identifier: ${repository}`)
  }
}

function assertCommit(commit: string): void {
  if (!/^[a-f0-9]{7,64}$/iu.test(commit)) {
    throw new Error(`Invalid repository commit: ${commit}`)
  }
}
