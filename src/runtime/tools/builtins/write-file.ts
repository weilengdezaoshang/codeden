import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { CodeDenError } from '../../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../../core/errors/error-codes.js'
import type { Tool, ToolContext } from '../tool.js'

export const WriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createParents: z.boolean().default(false),
})

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>

export class WriteFileTool implements Tool<WriteFileInput> {
  readonly name = 'write_file'
  readonly description = 'Write a UTF-8 text file in the workspace'
  readonly inputSchema = WriteFileInputSchema
  readonly sideEffect = 'write' as const

  async execute(input: WriteFileInput, context: ToolContext) {
    const abs = await context.policy.resolveWritable(input.path)
    if (input.createParents) {
      await mkdir(path.dirname(abs), { recursive: true })
    }

    try {
      await writeFile(abs, input.content, 'utf8')
    } catch (error) {
      throw new CodeDenError({
        code: ErrorCodes.WORKSPACE_IO_FAILED,
        category: 'workspace',
        message: 'Failed to write file',
        retryable: false,
        details: {
          path: input.path,
          cause: error instanceof Error ? error.message : String(error),
        },
      })
    }

    return { path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') }
  }
}
