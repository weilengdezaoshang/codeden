import { createHash } from 'node:crypto'
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodeDenError } from '../../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../../core/errors/error-codes.js'
import { pickCommandEnv } from '../../../runtime/process-env.js'
import {
  killProcessGroup,
  spawnInProcessGroup,
} from '../../../runtime/process/kill-process-group.js'
import { createBoundedBuffer } from '../../../runtime/verification/clip-text.js'
import { isIgnoredWorkspaceEntry } from '../../../runtime/workspace/ignored-paths.js'
import { WorkspacePolicy } from '../../../runtime/workspace/workspace-policy.js'
import type {
  CommandResult,
  CommandSpec,
  WorkspaceFactory,
  WorkspacePort,
} from '../../ports/workspace.port.js'

export interface TempDirFactory {
  mkdtemp(prefix: string): Promise<string>
}

const defaultTempDirFactory: TempDirFactory = {
  async mkdtemp(prefix: string): Promise<string> {
    return mkdtemp(path.join(tmpdir(), prefix))
  },
}

export interface TemporaryWorkspaceOptions {
  root: string
  fixturePath?: string
  deleteOnDispose?: boolean
  allowCommands?: boolean
  allowVerificationCommands?: boolean
  writableRoots?: string[]
  readableRoots?: string[]
  tempDirFactory?: TempDirFactory
}

export class TemporaryWorkspaceAdapter implements WorkspacePort {
  readonly root: string
  readonly verificationCommandsAllowed: boolean
  private readonly fixturePath: string | undefined
  private readonly deleteOnDispose: boolean
  private readonly policy: WorkspacePolicy
  private snapshot = new Map<string, string>()
  private disposed = false

  private constructor(options: TemporaryWorkspaceOptions) {
    this.root = options.root
    this.fixturePath = options.fixturePath
    this.deleteOnDispose = options.deleteOnDispose ?? true
    this.verificationCommandsAllowed = options.allowVerificationCommands ?? false
    this.policy = new WorkspacePolicy(options.root, {
      readableRoots: options.readableRoots ?? ['.'],
      writableRoots: options.writableRoots ?? ['.'],
      allowCommands: options.allowCommands ?? true,
    })
  }

  static async fromFixture(
    fixturePath: string,
    options: Omit<TemporaryWorkspaceOptions, 'root' | 'fixturePath'> = {},
  ): Promise<TemporaryWorkspaceAdapter> {
    const factory = options.tempDirFactory ?? defaultTempDirFactory
    let root: string
    try {
      root = await factory.mkdtemp('codeden-ws-')
      await cp(fixturePath, root, { recursive: true })
    } catch (error) {
      throw new CodeDenError({
        code: ErrorCodes.WORKSPACE_SETUP_FAILED,
        category: 'infrastructure',
        message: 'Failed to prepare temporary workspace',
        retryable: false,
        details: { fixturePath, cause: error instanceof Error ? error.message : String(error) },
      })
    }

    const workspace = new TemporaryWorkspaceAdapter({
      ...options,
      root,
      fixturePath,
      deleteOnDispose: options.deleteOnDispose ?? true,
    })
    await workspace.captureSnapshot()
    return workspace
  }

  static async fromExisting(
    root: string,
    options: Omit<TemporaryWorkspaceOptions, 'root'> = {},
  ): Promise<TemporaryWorkspaceAdapter> {
    const workspace = new TemporaryWorkspaceAdapter({
      ...options,
      root,
      deleteOnDispose: options.deleteOnDispose ?? false,
    })
    await workspace.captureSnapshot()
    return workspace
  }

  async readFile(relPath: string): Promise<string> {
    const abs = await this.policy.resolveReadable(relPath)
    try {
      return await readFile(abs, 'utf8')
    } catch (error) {
      throw ioError('Failed to read workspace file', relPath, error)
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = await this.policy.resolveWritable(relPath)
    try {
      await writeFile(abs, content, 'utf8')
    } catch (error) {
      throw ioError('Failed to write workspace file', relPath, error)
    }
  }

  async exec(command: CommandSpec): Promise<CommandResult> {
    this.policy.assertCommandsAllowed()
    const isolatedHome = await mkdtemp(path.join(tmpdir(), 'codeden-home-'))
    const started = performance.now()
    return await new Promise((resolve, reject) => {
      const child = spawnInProcessGroup(command.command, command.args ?? [], {
        cwd: this.root,
        env: pickCommandEnv({ HOME: isolatedHome, TMPDIR: tmpdir() }),
      })
      const stdout = createBoundedBuffer()
      const stderr = createBoundedBuffer()
      let settled = false
      const finish = (error?: Error, result?: CommandResult) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        if (error) {
          reject(error)
          return
        }
        resolve(result!)
      }
      const timer = setTimeout(() => {
        killProcessGroup(child)
        finish(
          new CodeDenError({
            code: ErrorCodes.COMMAND_TIMEOUT,
            category: 'timeout',
            message: 'Workspace command timed out',
            retryable: false,
          }),
        )
      }, command.timeoutMs ?? 10_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.push(chunk.toString('utf8'))
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk.toString('utf8'))
      })
      child.on('error', (error) => {
        finish(ioError('Failed to start workspace command', command.command, error))
      })
      child.on('close', (code) => {
        finish(undefined, {
          exitCode: code ?? 1,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          durationMs: Math.round(performance.now() - started),
        })
      })
    })
  }

  async changedPaths(): Promise<string[]> {
    const current = await this.walkHashes(this.root)
    const paths = new Set([...this.snapshot.keys(), ...current.keys()])
    const changed: string[] = []
    for (const rel of paths) {
      if (this.snapshot.get(rel) !== current.get(rel)) {
        changed.push(rel)
      }
    }
    return changed.sort()
  }

  async reset(): Promise<void> {
    if (!this.fixturePath) {
      throw new CodeDenError({
        code: ErrorCodes.WORKSPACE_IO_FAILED,
        category: 'workspace',
        message: 'Workspace cannot reset without a fixture',
        retryable: false,
      })
    }
    const entries = await readdir(this.root)
    await Promise.all(
      entries.map((entry) => rm(path.join(this.root, entry), { recursive: true, force: true })),
    )
    await cp(this.fixturePath, this.root, { recursive: true })
    await this.captureSnapshot()
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.deleteOnDispose) {
      await rm(this.root, { recursive: true, force: true })
    }
  }

  private async captureSnapshot(): Promise<void> {
    this.snapshot = await this.walkHashes(this.root)
  }

  private async walkHashes(root: string, prefix = ''): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (isIgnoredWorkspaceEntry(entry.name)) {
        continue
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = path.join(root, entry.name)
      if (entry.isDirectory()) {
        const nested = await this.walkHashes(abs, rel)
        for (const [key, value] of nested) {
          result.set(key, value)
        }
      } else if (entry.isFile()) {
        const fileStat = await stat(abs)
        const content = await readFile(abs)
        result.set(rel, `${fileStat.size}:${sha256(content)}`)
      }
    }
    return result
  }
}

export class TemporaryWorkspaceFactory implements WorkspaceFactory {
  constructor(
    private readonly tempDirFactory: TempDirFactory = defaultTempDirFactory,
    private readonly allowVerificationCommands = false,
  ) {}

  create(fixture: { path: string }): Promise<WorkspacePort> {
    return TemporaryWorkspaceAdapter.fromFixture(fixture.path, {
      tempDirFactory: this.tempDirFactory,
      allowVerificationCommands: this.allowVerificationCommands,
    })
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function ioError(message: string, inputPath: string, error: unknown): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.WORKSPACE_IO_FAILED,
    category: 'workspace',
    message,
    retryable: false,
    details: { path: inputPath, cause: error instanceof Error ? error.message : String(error) },
  })
}
