import { z } from 'zod'
import { collectCodeFiles, lineText } from './code-search.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z
    .enum(['function', 'class', 'interface', 'type', 'enum', 'struct', 'trait', 'def'])
    .optional(),
  path: z.string().trim().min(1).default('.'),
  maxResults: z.number().int().min(1).max(500).default(50),
})

export type FindSymbolInput = z.infer<typeof InputSchema>

export class FindSymbolTool implements Tool<FindSymbolInput> {
  readonly name = 'find_symbol'
  readonly description = 'Find source definitions by symbol name and optionally by symbol kind.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'read' as const

  async execute(input: FindSymbolInput, context: ToolContext) {
    const collected = await collectCodeFiles(context, input.path, 1_000)
    const results: Array<{ path: string; line: number; kind: string; text: string }> = []
    const escaped = escapeRegExp(input.name)
    const kinds = input.kind ?? 'function|class|interface|type|enum|struct|trait|def'
    const pattern = new RegExp(
      `^\\s*(?:(?:export|public|private|protected|async|pub|fn)\\s+)*(?:${input.kind ? escapeRegExp(input.kind) : kinds})\\s+${escaped}\\b`,
      'u',
    )
    for (const file of collected.files) {
      for (const [index, line] of file.content.split('\n').entries()) {
        if (pattern.test(line)) {
          results.push({
            path: file.relativePath,
            line: index + 1,
            kind: input.kind ?? 'symbol',
            text: lineText(file.content, index + 1),
          })
          if (results.length >= input.maxResults) {
            return { name: input.name, results, truncated: true }
          }
        }
      }
    }
    return { name: input.name, results, truncated: collected.truncated }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
