import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathPolicyOf } from '../tool-security.js'
import type { ToolContext } from '../tool.js'

export const CODE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.java',
  '.js',
  '.jsx',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
])

const IGNORED_DIRECTORIES = new Set(['.git', '.codex', 'node_modules', 'dist', 'build', '.cache'])
const MAX_FILE_BYTES = 512 * 1024

export interface CodeFile {
  absolutePath: string
  relativePath: string
  content: string
}

export async function collectCodeFiles(
  context: ToolContext,
  inputPath: string,
  maxFiles: number,
): Promise<{ files: CodeFile[]; truncated: boolean }> {
  pathPolicyOf(context).assertReadable(inputPath)
  const root = await context.policy.resolveReadable(inputPath)
  const files: CodeFile[] = []
  let truncated = false

  const visit = async (directory: string, relative: string): Promise<void> => {
    if (files.length >= maxFiles) {
      truncated = true
      return
    }
    const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const child of children) {
      if (files.length >= maxFiles) {
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
      const childAbsolute = path.join(directory, child.name)
      if (child.isDirectory()) {
        await visit(childAbsolute, childRelative)
        continue
      }
      if (!child.isFile() || !CODE_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
        continue
      }
      const info = await stat(childAbsolute)
      if (info.size > MAX_FILE_BYTES) {
        continue
      }
      const content = await readFile(childAbsolute, 'utf8')
      if (content.includes('\u0000')) {
        continue
      }
      files.push({ absolutePath: childAbsolute, relativePath: childRelative, content })
    }
  }

  const info = await stat(root)
  if (info.isFile()) {
    if (info.size > MAX_FILE_BYTES) {
      return { files: [], truncated: true }
    }
    const content = await readFile(root, 'utf8')
    if (content.includes('\u0000')) {
      return { files: [], truncated: false }
    }
    return {
      files: [
        { absolutePath: root, relativePath: toRelative(context.workspaceRoot, root), content },
      ],
      truncated: false,
    }
  }
  await visit(root, toRelative(context.workspaceRoot, root))
  return { files, truncated }
}

export function toRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join('/') || '.'
}

export function lineText(content: string, line: number): string {
  return (content.split('\n')[line - 1] ?? '').trim().slice(0, 240)
}
