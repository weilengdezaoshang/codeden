import { z } from 'zod'
import { collectCodeFiles } from './code-search.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({
  path: z.string().trim().min(1).default('.'),
  maxFiles: z.number().int().min(1).max(1_000).default(300),
  maxSymbols: z.number().int().min(1).max(10_000).default(2_000),
})

export type RepoMapInput = z.infer<typeof InputSchema>

export class RepoMapTool implements Tool<RepoMapInput> {
  readonly name = 'repo_map'
  readonly description =
    'Build a compact map of source files and their top-level symbols in the workspace.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'read' as const

  async execute(input: RepoMapInput, context: ToolContext) {
    const collected = await collectCodeFiles(context, input.path, input.maxFiles)
    let remainingSymbols = input.maxSymbols
    const files = collected.files.map((file) => {
      const symbols = symbolsOf(file.content).slice(0, remainingSymbols)
      remainingSymbols -= symbols.length
      return { path: file.relativePath, symbols }
    })
    const symbols = files.reduce((total, file) => total + file.symbols.length, 0)
    return {
      path: input.path,
      files,
      fileCount: files.length,
      symbolCount: symbols,
      truncated: collected.truncated,
    }
  }
}

function symbolsOf(content: string): Array<{ name: string; kind: string; line: number }> {
  const result: Array<{ name: string; kind: string; line: number }> = []
  const pattern =
    /^\s*(?:(?:export|public|private|protected|async|pub|fn)\s+)*(function|class|interface|type|enum|struct|trait|def|const|var|func)\s+([A-Za-z_$][\w$]*)/u
  for (const [index, line] of content.split('\n').entries()) {
    const match = line.match(pattern)
    if (match) {
      result.push({ name: match[2] ?? '', kind: match[1] ?? 'symbol', line: index + 1 })
    }
  }
  return result.filter((item) => item.name.length > 0)
}
