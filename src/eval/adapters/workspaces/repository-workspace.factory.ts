import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CodeDenError } from '../../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../../core/errors/error-codes.js'
import type {
  WorkspaceFactory,
  WorkspaceFixture,
  WorkspacePort,
} from '../../ports/workspace.port.js'
import {
  TemporaryWorkspaceAdapter,
  TemporaryWorkspaceFactory,
} from './temporary-workspace.adapter.js'

const execFileAsync = promisify(execFile)

export interface RepositoryWorkspaceFactoryOptions {
  allowVerificationCommands?: boolean
  resolveRepositoryUrl?: (repository: string) => string
  localFactory?: WorkspaceFactory
}

export class RepositoryWorkspaceFactory implements WorkspaceFactory {
  private readonly allowVerificationCommands: boolean
  private readonly resolveRepositoryUrl: (repository: string) => string
  private readonly localFactory: WorkspaceFactory

  constructor(options: RepositoryWorkspaceFactoryOptions = {}) {
    this.allowVerificationCommands = options.allowVerificationCommands ?? false
    this.resolveRepositoryUrl =
      options.resolveRepositoryUrl ?? ((repository) => `https://github.com/${repository}.git`)
    this.localFactory = options.localFactory ?? new TemporaryWorkspaceFactory()
  }

  async create(fixture: WorkspaceFixture): Promise<WorkspacePort> {
    if (!fixture.repository) {
      return this.localFactory.create(fixture)
    }

    assertRepository(fixture.repository.repository)
    assertCommit(fixture.repository.baseCommit)
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-repo-'))
    try {
      await git([
        'clone',
        '--no-checkout',
        '--',
        this.resolveRepositoryUrl(fixture.repository.repository),
        root,
      ])
      await git(['-C', root, 'checkout', '--detach', fixture.repository.baseCommit])
      if (fixture.repository.testPatch.trim()) {
        const patchPath = path.join(root, '.codeden-test.patch')
        await writeFile(patchPath, fixture.repository.testPatch, 'utf8')
        try {
          await git(['-C', root, 'apply', '--whitespace=nowarn', '--', patchPath])
        } finally {
          await rm(patchPath, { force: true })
        }
      }
      return TemporaryWorkspaceAdapter.fromExisting(root, {
        deleteOnDispose: true,
        allowCommands: true,
        allowVerificationCommands: this.allowVerificationCommands,
      })
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw new CodeDenError({
        code: ErrorCodes.WORKSPACE_SETUP_FAILED,
        category: 'infrastructure',
        message: 'Failed to prepare repository fixture',
        retryable: false,
        details: { cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

async function git(args: string[]): Promise<void> {
  await execFileAsync('git', args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 })
}

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
