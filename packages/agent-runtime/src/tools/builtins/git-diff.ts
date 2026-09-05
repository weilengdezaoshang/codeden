import { z } from 'zod'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { gitExec } from '../../workspace/git-repository.js'
import { pathPolicyOf, redactorOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'

const MAX_DIFF_BYTES = 1_000_000
const InputSchema = z.object({
  path: z.string().trim().min(1).default('.'),
  staged: z.boolean().default(false),
})
export type GitDiffInput = z.infer<typeof InputSchema>

export class GitDiffTool implements Tool<GitDiffInput> {
  readonly name = 'git_diff'
  readonly description = 'Return the bounded textual Git diff for a workspace path.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'read' as const

  async execute(input: GitDiffInput, context: ToolContext) {
    pathPolicyOf(context).assertReadable(input.path)
    const resolved = await context.policy.resolveReadable(input.path)
    const info = await lstat(resolved)
    const root = info.isFile() ? path.dirname(resolved) : resolved
    const pathspec = info.isFile() ? path.basename(resolved) : '.'
    const raw = await gitExec(root, ['diff', ...(input.staged ? ['--cached'] : []), '--', pathspec])
    const diff = redactorOf(context).redact(raw)
    return {
      path: input.path,
      staged: input.staged,
      diff: diff.slice(0, MAX_DIFF_BYTES),
      truncated: Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES,
    }
  }
}
