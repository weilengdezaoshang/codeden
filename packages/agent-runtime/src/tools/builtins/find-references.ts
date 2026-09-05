import { z } from 'zod'
import { collectCodeFiles, lineText } from './code-search.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).default('.'),
  maxResults: z.number().int().min(1).max(1_000).default(100),
  excludeDefinitions: z.boolean().default(false),
})

export type FindReferencesInput = z.infer<typeof InputSchema>

export class FindReferencesTool implements Tool<FindReferencesInput> {
  readonly name = 'find_references'
  readonly description = 'Find textual references to a symbol across source files.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'read' as const

  async execute(input: FindReferencesInput, context: ToolContext) {
    const collected = await collectCodeFiles(context, input.path, 1_000)
    const results: Array<{ path: string; line: number; text: string }> = []
    const pattern = new RegExp(`\\b${escapeRegExp(input.name)}\\b`, 'u')
    const definition = new RegExp(
      `^\\s*(?:(?:export|public|private|protected|async|pub|fn)\\s+)*(?:function|class|interface|type|enum|struct|trait|def)\\s+${escapeRegExp(input.name)}\\b`,
      'u',
    )
    for (const file of collected.files) {
      for (const [index, line] of file.content.split('\n').entries()) {
        if (!pattern.test(line) || (input.excludeDefinitions && definition.test(line))) {
          continue
        }
        results.push({
          path: file.relativePath,
          line: index + 1,
          text: lineText(file.content, index + 1),
        })
        if (results.length >= input.maxResults) {
          return { name: input.name, results, truncated: true }
        }
      }
    }
    return { name: input.name, results, truncated: collected.truncated }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
