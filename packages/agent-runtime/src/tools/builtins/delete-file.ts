import { lstat, rm } from 'node:fs/promises'
import { z } from 'zod'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { pathPolicyOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({ path: z.string().min(1) })
export type DeleteFileInput = z.infer<typeof InputSchema>

export class DeleteFileTool implements Tool<DeleteFileInput> {
  readonly name = 'delete_file'
  readonly description = 'Delete one regular file inside the workspace.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'write' as const

  async execute(input: DeleteFileInput, context: ToolContext) {
    pathPolicyOf(context).assertWritable(input.path)
    const absolute = await context.policy.resolveWritable(input.path)
    const info = await lstat(absolute).catch((error: unknown) => {
      if (isMissing(error)) {
        throw new CodeDenError({
          code: ErrorCodes.WORKSPACE_IO_FAILED,
          category: 'workspace',
          message: `File does not exist: ${input.path}`,
          retryable: false,
        })
      }
      throw error
    })
    if (!info.isFile()) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_EXECUTION_FAILED,
        category: 'tool',
        message: `Only regular files can be deleted: ${input.path}`,
        retryable: false,
      })
    }
    await rm(absolute)
    return { path: input.path, deleted: true }
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
