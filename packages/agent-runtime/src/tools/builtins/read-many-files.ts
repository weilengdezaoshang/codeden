import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { toPosixRel } from '@codeden/core/security/sensitive-path-policy.js'
import { guardOf, pathPolicyOf, redactorOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(50),
  maxBytesPerFile: z.number().int().min(1).max(1_000_000).default(200_000),
})

export type ReadManyFilesInput = z.infer<typeof InputSchema>

export class ReadManyFilesTool implements Tool<ReadManyFilesInput> {
  readonly name = 'read_many_files'
  readonly description = 'Read several UTF-8 workspace files in one tool call with bounded output.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'read' as const

  async execute(input: ReadManyFilesInput, context: ToolContext) {
    const files = []
    for (const filePath of input.paths) {
      pathPolicyOf(context).assertReadable(filePath)
      const absolute = await context.policy.resolveReadable(filePath)
      pathPolicyOf(context).assertReadable(toPosixRel(context.workspaceRoot, absolute))
      const bytes = await readFile(absolute)
      const truncated = bytes.byteLength > input.maxBytesPerFile
      const content = redactorOf(context).redact(
        bytes.subarray(0, input.maxBytesPerFile).toString('utf8'),
      )
      guardOf(context).assertSafe(content, 'tool:read_many_files')
      files.push({ path: filePath, content, bytes: bytes.byteLength, truncated })
    }
    return { files }
  }
}
