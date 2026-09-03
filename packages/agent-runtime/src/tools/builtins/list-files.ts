import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { pathPolicyOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'

const IGNORED_DIRECTORIES = new Set(['.git', '.codex', 'node_modules'])

export const ListFilesInputSchema = z.object({
  path: z.string().trim().min(1).default('.'),
  maxDepth: z.number().int().min(0).max(5).default(2),
  maxEntries: z.number().int().min(1).max(1_000).default(300),
})

export type ListFilesInput = z.infer<typeof ListFilesInputSchema>

export class ListFilesTool implements Tool<ListFilesInput> {
  readonly name = 'list_files'
  readonly description =
    'List files and directories in the workspace for project inspection. Read-only and does not require permission. Use this instead of run_command for ls, find, or directory discovery.'
  readonly inputSchema = ListFilesInputSchema
  readonly sideEffect = 'read' as const

  async execute(input: ListFilesInput, context: ToolContext) {
    pathPolicyOf(context).assertReadable(input.path)
    const root = await context.policy.resolveReadable(input.path)
    const rootRelative = toRelative(context.workspaceRoot, root)
    const entries: string[] = []
    let truncated = false

    const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
      if (depth > input.maxDepth || entries.length >= input.maxEntries) {
        truncated = entries.length >= input.maxEntries
        return
      }
      const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
      )
      for (const child of children) {
        if (entries.length >= input.maxEntries) {
          truncated = true
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
        entries.push(child.isDirectory() ? `${childRelative}/` : childRelative)
        if (child.isDirectory() && depth < input.maxDepth) {
          await visit(path.join(directory, child.name), childRelative, depth + 1)
        }
      }
    }

    await visit(root, rootRelative, 0)
    return { path: input.path, entries, truncated }
  }
}

function toRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath).split(path.sep).join('/')
  return relative || ''
}
