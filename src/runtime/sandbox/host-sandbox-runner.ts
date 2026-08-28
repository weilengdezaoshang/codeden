import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import { pickCommandEnv } from '../process-env.js'
import { killProcessGroup, spawnInProcessGroup } from '../process/kill-process-group.js'
import type {
  SandboxCommand,
  SandboxContext,
  SandboxResult,
  SandboxRunner,
} from './sandbox-runner.js'

const MAX_OUTPUT = 64_000

export class HostSandboxRunner implements SandboxRunner {
  async run(command: SandboxCommand, context: SandboxContext): Promise<SandboxResult> {
    const home = await mkdtemp(path.join(tmpdir(), 'codeden-home-'))
    const started = performance.now()
    try {
      const child = spawnInProcessGroup(command.command, command.args, {
        cwd: context.workspaceRoot,
        env: pickCommandEnv({ HOME: home, TMPDIR: tmpdir() }),
      })
      return await new Promise((resolve, reject) => {
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
        const timer = setTimeout(() => {
          killProcessGroup(child)
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
          killProcessGroup(child)
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
              message: error.message,
              retryable: false,
              details: { command: command.command },
            }),
          ),
        )
        child.on('close', (exitCode) => {
          code = exitCode
          finish()
        })
      })
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {}
}
