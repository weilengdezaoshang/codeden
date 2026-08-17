import { isUtf8 } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { CodeDenError } from '../../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../../core/errors/error-codes.js'
import type { Tool, ToolContext } from '../tool.js'

export const ReadFileInputSchema = z.object({
  path: z.string().min(1),
})

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>

export const MAX_READ_BYTES = 1_000_000

export class ReadFileTool implements Tool<ReadFileInput> {
  readonly name = 'read_file'
  readonly description = 'Read a UTF-8 text file from the workspace'
  readonly inputSchema = ReadFileInputSchema
  readonly sideEffect = 'read' as const

  async execute(input: ReadFileInput, context: ToolContext) {
    const abs = await context.policy.resolveReadable(input.path)
    let bytes: Buffer
    try {
      bytes = await readFile(abs)
    } catch (error) {
      throw ioError('Failed to read file', input.path, error)
    }

    if (bytes.byteLength > MAX_READ_BYTES) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_EXECUTION_FAILED,
        category: 'tool',
        message: `File exceeds max read size (${MAX_READ_BYTES} bytes)`,
        retryable: false,
        details: { path: input.path, size: bytes.byteLength },
      })
    }

    if (!isUtf8(bytes)) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_EXECUTION_FAILED,
        category: 'tool',
        message: 'Only text files can be read',
        retryable: false,
        details: { path: input.path },
      })
    }

    const content = bytes.toString('utf8')
    return { path: input.path, content, bytes: bytes.byteLength }
  }
}

function ioError(message: string, inputPath: string, error: unknown): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.WORKSPACE_IO_FAILED,
    category: 'workspace',
    message,
    retryable: false,
    details: { path: inputPath, cause: error instanceof Error ? error.message : String(error) },
  })
}
