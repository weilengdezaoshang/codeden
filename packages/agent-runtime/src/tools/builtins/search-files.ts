import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { pathPolicyOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'

const IGNORED_DIRECTORIES = new Set(['.git', '.codex', 'node_modules'])
const MAX_FILE_BYTES = 512 * 1024
const MAX_MATCH_CHARS = 240

export const SearchFilesInputSchema = z.object({
  pattern: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).default('.'),
  /** 可选的相对路径 glob（支持星号、双星号和问号），例如 TypeScript 源文件模式。 */
  glob: z.string().trim().min(1).max(200).optional(),
  isRegex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(200).default(50),
})

export type SearchFilesInput = z.infer<typeof SearchFilesInputSchema>

export interface FileMatch {
  path: string
  line: number
  text: string
}

/** 按内容搜索工作区文件，避免为了一次 grep 绕道 run_command。 */
export class SearchFilesTool implements Tool<SearchFilesInput> {
  readonly name = 'search_files'
  readonly description =
    'Search file contents in the workspace by literal text or regular expression and get matching file:line results. Read-only and does not require permission. Use this instead of run_command for grep, ripgrep, or code search.'
  readonly inputSchema = SearchFilesInputSchema
  readonly sideEffect = 'read' as const

  async execute(input: SearchFilesInput, context: ToolContext) {
    pathPolicyOf(context).assertReadable(input.path)
    const root = await context.policy.resolveReadable(input.path)
    const regex = buildMatcher(input)
    const globMatcher = input.glob ? buildGlobMatcher(input.glob) : undefined
    const matches: FileMatch[] = []
    let filesSearched = 0
    let truncated = false

    const visit = async (directory: string, relative: string): Promise<void> => {
      if (truncated) {
        return
      }
      const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
      )
      for (const child of children) {
        if (truncated) {
          return
        }
        if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) {
          continue
        }
        const childRelative = relative ? path.posix.join(relative, child.name) : child.name
        try {
          pathPolicyOf(context).assertReadable(childRelative)
        } catch {
          continue
        }
        if (child.isDirectory()) {
          await visit(path.join(directory, child.name), childRelative)
          continue
        }
        if (!child.isFile() || (globMatcher && !globMatcher(childRelative))) {
          continue
        }
        filesSearched += 1
        const fileMatches = await searchFile(
          path.join(directory, child.name),
          childRelative,
          regex,
          input.maxResults - matches.length,
        )
        for (const match of fileMatches) {
          matches.push(match)
          if (matches.length >= input.maxResults) {
            truncated = true
            return
          }
        }
      }
    }

    await visit(root, toRelative(context.workspaceRoot, root))
    return { pattern: input.pattern, path: input.path, matches, filesSearched, truncated }
  }
}

async function searchFile(
  absolutePath: string,
  relativePath: string,
  regex: RegExp,
  budget: number,
): Promise<FileMatch[]> {
  if (budget <= 0) {
    return []
  }
  const info = await stat(absolutePath)
  if (info.size > MAX_FILE_BYTES || info.size === 0) {
    return []
  }
  const content = await readFile(absolutePath, 'utf8')
  if (content.includes('\u0000')) {
    // NUL 字节视为二进制文件，跳过以避免噪声匹配。
    return []
  }
  const matches: FileMatch[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length && matches.length < budget; index += 1) {
    if (!regex.test(lines[index] ?? '')) {
      continue
    }
    const text = (lines[index] ?? '').trim()
    matches.push({
      path: relativePath,
      line: index + 1,
      text: text.length > MAX_MATCH_CHARS ? `${text.slice(0, MAX_MATCH_CHARS)}…` : text,
    })
  }
  return matches
}

function buildMatcher(input: SearchFilesInput): RegExp {
  const source = input.isRegex ? input.pattern : escapeRegExp(input.pattern)
  return new RegExp(source, input.caseSensitive ? 'u' : 'iu')
}

function buildGlobMatcher(glob: string): (relativePath: string) => boolean {
  const source = escapeRegExp(glob)
    .replaceAll('\\*\\*/', '(?:.*/)?')
    .replaceAll('\\*', '[^/]*')
    .replaceAll('\\?', '.')
  const regex = new RegExp(`^(?:${source})$`, 'u')
  return (relativePath) => regex.test(relativePath)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function toRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath).split(path.sep).join('/')
  return relative || ''
}
