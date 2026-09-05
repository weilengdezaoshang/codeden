import { lstat, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { pathPolicyOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({ from: z.string().min(1), to: z.string().min(1) })
export type MoveFileInput = z.infer<typeof InputSchema>

export class MoveFileTool implements Tool<MoveFileInput> {
  readonly name = 'move_file'
  readonly description =
    'Move or rename a workspace file or directory without overwriting its destination.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'write' as const

  async execute(input: MoveFileInput, context: ToolContext) {
    pathPolicyOf(context).assertWritable(input.from)
    pathPolicyOf(context).assertWritable(input.to)
    const source = await context.policy.resolveWritable(input.from)
    const destination = await context.policy.resolveWritable(input.to)
    await lstat(source).catch((error: unknown) => {
      if (isMissing(error)) {
        throw new CodeDenError({
          code: ErrorCodes.WORKSPACE_IO_FAILED,
          category: 'workspace',
          message: `Source does not exist: ${input.from}`,
          retryable: false,
        })
      }
      throw error
    })
    if (await exists(destination)) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_EXECUTION_FAILED,
        category: 'tool',
        message: `Destination already exists: ${input.to}`,
        retryable: false,
      })
    }
    await mkdir(path.dirname(destination), { recursive: true })
    await rename(source, destination)
    return { from: input.from, to: input.to, moved: true }
  }
}

async function exists(filePath: string): Promise<boolean> {
  return lstat(filePath)
    .then(() => true)
    .catch((error: unknown) => {
      if (isMissing(error)) {
        return false
      }
      throw error
    })
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
