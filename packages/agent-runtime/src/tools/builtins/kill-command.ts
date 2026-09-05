import { z } from 'zod'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { redactorOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'
import { BackgroundTaskManager } from '../background-task-manager.js'

const InputSchema = z.object({ taskId: z.string().uuid() })

export type KillCommandInput = z.infer<typeof InputSchema>

export class KillCommandTool implements Tool<KillCommandInput> {
  readonly name = 'kill_command'
  readonly description = 'Terminate a running background command and its process group.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'process' as const

  constructor(private readonly tasks: BackgroundTaskManager) {}

  async execute(input: KillCommandInput, context: ToolContext) {
    try {
      const result = await this.tasks.kill(input.taskId)
      return {
        ...result,
        stdout: redactorOf(context).redact(result.stdout),
        stderr: redactorOf(context).redact(result.stderr),
      }
    } catch (error) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_EXECUTION_FAILED,
        category: 'tool',
        message: error instanceof Error ? error.message : 'Background task termination failed',
        retryable: false,
        details: { taskId: input.taskId },
      })
    }
  }
}
