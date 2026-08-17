import { spawn } from 'node:child_process'
import { z } from 'zod'
import { CodeDenError } from '../../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../../core/errors/error-codes.js'
import { pickCommandEnv } from '../../process-env.js'
import type { Tool, ToolContext } from '../tool.js'

export const RunCommandInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(10_000),
})

export type RunCommandInput = z.infer<typeof RunCommandInputSchema>

export class RunCommandTool implements Tool<RunCommandInput> {
  readonly name = 'run_command'
  readonly description = 'Run a process without a shell in the workspace root'
  readonly inputSchema = RunCommandInputSchema
  readonly sideEffect = 'process' as const

  async execute(input: RunCommandInput, context: ToolContext) {
    context.policy.assertCommandsAllowed()

    const started = performance.now()
    return await new Promise<{
      exitCode: number
      stdout: string
      stderr: string
      durationMs: number
    }>((resolve, reject) => {
      const child = spawn(input.command, input.args, {
        cwd: context.workspaceRoot,
        shell: false,
        env: pickCommandEnv(),
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
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
        child.kill('SIGKILL')
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
          stdout,
          stderr,
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
