import { z } from 'zod'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({
  question: z.string().trim().min(1).max(1_000),
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(9),
})
export type AskUserInput = z.infer<typeof InputSchema>

export class AskUserTool implements Tool<AskUserInput> {
  readonly name = 'ask_user'
  readonly description = 'Ask the user a multiple-choice question when the task needs a decision.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'read' as const

  async execute(input: AskUserInput, context: ToolContext) {
    if (!context.askUser) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_PERMISSION_DENIED,
        category: 'permission',
        message: 'No interactive user input channel is available',
        retryable: false,
      })
    }
    const answer = await context.askUser(input.question, input.options, context.abortSignal)
    if (!answer) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_PERMISSION_DENIED,
        category: 'permission',
        message: 'User did not provide an answer',
        retryable: false,
      })
    }
    return { question: input.question, answer, options: input.options }
  }
}
