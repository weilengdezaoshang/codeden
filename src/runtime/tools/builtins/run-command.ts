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
import type { SandboxRunner } from '../../sandbox/sandbox-runner.js'
import { DockerSandboxRunner } from '../../sandbox/docker-sandbox-runner.js'
import { HostSandboxRunner } from '../../sandbox/host-sandbox-runner.js'

const MAX_STREAM_CHARS = 64_000

export type CommandSandboxMode = 'host' | 'docker'

export interface RunCommandOptions {
  mode?: CommandSandboxMode
  image?: string
  readOnly?: boolean
  dockerContext?: string
  dockerHost?: string
  runner?: SandboxRunner
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

  private readonly sandboxRunner: SandboxRunner

  constructor(private readonly options: RunCommandOptions = {}) {
    this.sandboxRunner =
      options.runner ??
      (options.mode === 'docker' ? new DockerSandboxRunner(options) : new HostSandboxRunner())
  }

  async execute(input: RunCommandInput, context: ToolContext) {
    context.policy.assertCommandsAllowed()
    pathPolicyOf(context).assertCommand(input.command, input.args)
    return this.sandboxRunner.run(input, {
      workspaceRoot: context.workspaceRoot,
      abortSignal: context.abortSignal,
      redact: (value) => redactorOf(context).redact(value),
    })
  }

  private async executeInHost(input: RunCommandInput, context: ToolContext) {
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
}
