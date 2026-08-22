import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { CodeDenError } from '../../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../../core/errors/error-codes.js'
import { pathPolicyOf, redactorOf } from '../../../security/tool-security.js'
import { pickCommandEnv } from '../../process-env.js'
import { killProcessGroup, spawnInProcessGroup } from '../../process/kill-process-group.js'
import type { Tool, ToolContext } from '../tool.js'

const MAX_STREAM_CHARS = 64_000

export type CommandSandboxMode = 'host' | 'docker'

export interface RunCommandOptions {
  mode?: CommandSandboxMode
  image?: string
  dockerContext?: string
  dockerHost?: string
}

export const RunCommandInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(10_000),
})

export type RunCommandInput = z.infer<typeof RunCommandInputSchema>

export class RunCommandTool implements Tool<RunCommandInput> {
  readonly name = 'run_command'
  readonly description =
    'Run a process without a shell in the workspace root. In Docker mode, execution is isolated from the network.'
  readonly inputSchema = RunCommandInputSchema
  readonly sideEffect = 'process' as const

  constructor(private readonly options: RunCommandOptions = {}) {}

  async execute(input: RunCommandInput, context: ToolContext) {
    context.policy.assertCommandsAllowed()
    pathPolicyOf(context).assertCommand(input.command, input.args)
    if (this.options.mode === 'docker') {
      return this.executeInDocker(input, context)
    }
    const isolatedHome = await mkdtemp(path.join(tmpdir(), 'codeden-home-'))
    const redactor = redactorOf(context)

    const started = performance.now()
    return await new Promise<{
      exitCode: number
      stdout: string
      stderr: string
      durationMs: number
    }>((resolve, reject) => {
      const child = spawnInProcessGroup(input.command, input.args, {
        cwd: context.workspaceRoot,
        env: pickCommandEnv({ HOME: isolatedHome, TMPDIR: tmpdir() }),
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        killProcessGroup(child)
        finish(
          new CodeDenError({
            code: ErrorCodes.COMMAND_TIMEOUT,
            category: 'timeout',
            message: `Command timed out after ${input.timeoutMs}ms`,
            retryable: false,
            details: { command: input.command, args: input.args },
          }),
        )
      }, input.timeoutMs)

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

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        finish(
          new CodeDenError({
            code: ErrorCodes.TOOL_EXECUTION_FAILED,
            category: 'tool',
            message: error.message,
            retryable: false,
            details: { command: input.command },
          }),
        )
      })
      child.on('close', (code) => {
        finish(undefined, {
          exitCode: code ?? 1,
          stdout: redactor.redact(stdout).slice(0, MAX_STREAM_CHARS),
          stderr: redactor.redact(stderr).slice(0, MAX_STREAM_CHARS),
          durationMs: Math.round(performance.now() - started),
        })
      })

      function finish(
        error?: CodeDenError,
        result?: { exitCode: number; stdout: string; stderr: string; durationMs: number },
      ) {
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
        resolve(result!)
      }
    })
  }

  private async executeInDocker(input: RunCommandInput, context: ToolContext) {
    const image = this.options.image ?? 'node:24-bookworm-slim'
    const started = performance.now()
    const redactor = redactorOf(context)
    const dockerArgs = [
      ...(this.options.dockerContext ? ['--context', this.options.dockerContext] : []),
      ...(this.options.dockerHost ? ['--host', this.options.dockerHost] : []),
      'run',
      '--rm',
      '--init',
      '--network',
      'none',
      '--user',
      'node',
      '--workdir',
      '/workspace',
      '--volume',
      `${context.workspaceRoot}:/workspace`,
      image,
      input.command,
      ...input.args,
    ]
    const child = spawnInProcessGroup('docker', dockerArgs, {
      cwd: context.workspaceRoot,
      // The host-side Docker CLI needs the user's context configuration (for
      // example Colima's socket). The task itself still runs with an isolated
      // HOME inside the container.
      env: {
        ...pickCommandEnv({ TMPDIR: tmpdir() }),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      },
    })
    return await new Promise<{
      exitCode: number
      stdout: string
      stderr: string
      durationMs: number
    }>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (error?: CodeDenError) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        context.abortSignal?.removeEventListener('abort', onAbort)
        if (error) {
          reject(error)
        } else {
          resolve({
            exitCode: exitCode ?? 1,
            stdout: redactor.redact(stdout).slice(0, MAX_STREAM_CHARS),
            stderr: redactor.redact(stderr).slice(0, MAX_STREAM_CHARS),
            durationMs: Math.round(performance.now() - started),
          })
        }
      }
      let exitCode: number | null = null
      const timer = setTimeout(() => {
        killProcessGroup(child)
        finish(
          new CodeDenError({
            code: ErrorCodes.COMMAND_TIMEOUT,
            category: 'timeout',
            message: `Command timed out after ${input.timeoutMs}ms`,
            retryable: false,
          }),
        )
      }, input.timeoutMs)
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
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) =>
        finish(
          new CodeDenError({
            code: ErrorCodes.TOOL_EXECUTION_FAILED,
            category: 'tool',
            message: `Docker sandbox failed: ${error.message}`,
            retryable: false,
            details: { image, workspaceRoot: context.workspaceRoot },
          }),
        ),
      )
      child.on('close', (code) => {
        exitCode = code
        finish()
      })
    })
  }
}
