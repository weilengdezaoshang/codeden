import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { killProcessGroup, spawnInProcessGroup } from '../process/kill-process-group.js'
import type {
  SandboxCommand,
  SandboxContext,
  SandboxResult,
  SandboxRunner,
} from './sandbox-runner.js'
import type { SandboxRunnerOptions } from './sandbox-runner-factory.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 64_000

export class DockerSandboxRunner implements SandboxRunner {
  constructor(private readonly options: SandboxRunnerOptions = {}) {}

  async run(command: SandboxCommand, context: SandboxContext): Promise<SandboxResult> {
    const name = `codeden-${randomUUID()}`
    const started = performance.now()
    const child = spawnInProcessGroup('docker', this.args(command, context, name), {
      cwd: context.workspaceRoot,
      env: { ...process.env, HOME: process.env.HOME, TMPDIR: tmpdir() },
    })
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        context.abortSignal?.removeEventListener('abort', onAbort)
        if (error) {
          reject(error)
          return
        }
        resolve({
          exitCode: code ?? 1,
          stdout: (context.redact ? context.redact(stdout) : stdout).slice(0, MAX_OUTPUT),
          stderr: (context.redact ? context.redact(stderr) : stderr).slice(0, MAX_OUTPUT),
          durationMs: Math.round(performance.now() - started),
        })
      }
      let code: number | null = null
      const cleanup = () => {
        killProcessGroup(child)
        void this.remove(name)
      }
      const timer = setTimeout(() => {
        cleanup()
        finish(
          new CodeDenError({
            code: ErrorCodes.COMMAND_TIMEOUT,
            category: 'timeout',
            message: `Command timed out after ${command.timeoutMs}ms`,
            retryable: false,
          }),
        )
      }, command.timeoutMs)
      const onAbort = () => {
        cleanup()
        finish(
          new CodeDenError({
            code: ErrorCodes.AGENT_TIMEOUT,
            category: 'timeout',
            message: 'Command aborted',
            retryable: false,
          }),
        )
      }
      context.abortSignal?.addEventListener('abort', onAbort)
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      child.on('error', (error) =>
        finish(
          new CodeDenError({
            code: ErrorCodes.TOOL_EXECUTION_FAILED,
            category: 'tool',
            message: `Docker sandbox failed: ${error.message}`,
            retryable: false,
          }),
        ),
      )
      child.on('close', (exitCode) => {
        code = exitCode
        finish()
      })
    })
  }

  async dispose(): Promise<void> {}

  private args(command: SandboxCommand, context: SandboxContext, name: string): string[] {
    const options = this.options
    return [
      ...(options.dockerContext ? ['--context', options.dockerContext] : []),
      ...(options.dockerHost ? ['--host', options.dockerHost] : []),
      'run',
      '--rm',
      '--name',
      name,
      '--init',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '256',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=64m',
      '--user',
      'node',
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,source=${context.workspaceRoot},target=/workspace${options.readOnly ? ',readonly' : ''}`,
      options.image ?? 'node:24-bookworm-slim',
      command.command,
      ...command.args,
    ]
  }

  private async remove(name: string): Promise<void> {
    const args = [
      ...(this.options.dockerContext ? ['--context', this.options.dockerContext] : []),
      ...(this.options.dockerHost ? ['--host', this.options.dockerHost] : []),
      'rm',
      '--force',
      name,
    ]
    await execFileAsync('docker', args).catch(() => undefined)
  }
}
