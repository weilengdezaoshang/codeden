import { z } from 'zod'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { redactorOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'
import { BackgroundTaskManager } from '../background-task-manager.js'

const InputSchema = z.object({
  taskId: z.string().uuid(),
  waitMs: z.number().int().min(0).max(30_000).default(0),
  stdoutOffset: z.number().int().min(0).default(0),
  stderrOffset: z.number().int().min(0).default(0),
})

export type GetCommandOutputInput = z.infer<typeof InputSchema>

export class GetCommandOutputTool implements Tool<GetCommandOutputInput> {
  readonly name = 'get_command_output'
  readonly description =
    'Get the status and output of a background command. Use offsets to request only output added since the previous call.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'read' as const

  constructor(private readonly tasks: BackgroundTaskManager) {}

  async execute(input: GetCommandOutputInput, context: ToolContext) {
    try {
      const result = await this.tasks.get(input.taskId, input)
      return {
        ...result,
        stdout: redactorOf(context).redact(result.stdout),
        stderr: redactorOf(context).redact(result.stderr),
      }
    } catch (error) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_EXECUTION_FAILED,
        category: 'tool',
        message: error instanceof Error ? error.message : 'Background task lookup failed',
        retryable: false,
        details: { taskId: input.taskId },
      })
    }
  }
}
