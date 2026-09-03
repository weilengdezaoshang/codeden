import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { toPosixRel } from '@codeden/core/security/sensitive-path-policy.js'
import { guardOf, pathPolicyOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'

export const EditFileInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string(),
  newText: z.string(),
})

export type EditFileInput = z.infer<typeof EditFileInputSchema>

export class EditFileTool implements Tool<EditFileInput> {
  readonly name = 'edit_file'
  readonly description = 'Replace exactly one occurrence of oldText in a workspace file'
  readonly inputSchema = EditFileInputSchema
  readonly sideEffect = 'write' as const

  async execute(input: EditFileInput, context: ToolContext) {
    pathPolicyOf(context).assertWritable(input.path)
    try {
      guardOf(context).assertSafe(input.newText, 'tool:edit_file')
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
    const abs = await context.policy.resolveWritable(input.path)
    pathPolicyOf(context).assertWritable(toPosixRel(context.workspaceRoot, abs))
    let original: string
    try {
      original = await readFile(abs, 'utf8')
    } catch (error) {
      throw ioError('Failed to read file for edit', input.path, error)
    }

    const hash = sha256(original)
    const matches = countOccurrences(original, input.oldText)
    if (matches !== 1) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_EXECUTION_FAILED,
        category: 'tool',
        message: `oldText must match exactly once, matched ${matches} time(s)`,
        retryable: false,
        details: { path: input.path, matches },
      })
    }

    let latest: string
    try {
      latest = await readFile(abs, 'utf8')
    } catch (error) {
      throw ioError('Failed to re-read file before write', input.path, error)
    }

    if (sha256(latest) !== hash) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_EXECUTION_FAILED,
        category: 'tool',
        message: 'File changed after read; refusing to edit',
        retryable: false,
        details: { path: input.path },
      })
    }

    const next = replaceLiteral(latest, input.oldText, input.newText)
    try {
      await writeFile(abs, next, 'utf8')
    } catch (error) {
      throw ioError('Failed to write edited file', input.path, error)
    }

    return { path: input.path, replacements: 1 }
  }
}

function replaceLiteral(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle)
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length)
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0
  }
  let count = 0
  let index = 0
  while (true) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) {
      return count
    }
    count += 1
    index = found + needle.length
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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
