import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { toPosixRel } from '@codeden/core/security/sensitive-path-policy.js'
import { guardOf, pathPolicyOf } from '../tool-security.js'
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
    pathPolicyOf(context).assertWritable(input.path)
    const abs = await context.policy.resolveWritable(input.path)
    pathPolicyOf(context).assertWritable(toPosixRel(context.workspaceRoot, abs))
    try {
      guardOf(context).assertSafe(input.content, 'tool:write_file')
    } catch (error) {
      if (error instanceof CodeDenError && error.code === ErrorCodes.SECRET_LEAK_DETECTED) {
        throw new CodeDenError({
          code: ErrorCodes.TOOL_OUTPUT_SECRET_DETECTED,
          category: 'permission',
          message: '写入内容包含敏感信息，已被安全策略拒绝',
          retryable: false,
        })
      }
      throw error
    }
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
