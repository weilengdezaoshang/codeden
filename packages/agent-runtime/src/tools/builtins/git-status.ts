import { z } from 'zod'
import { gitExec } from '../../workspace/git-repository.js'
import { pathPolicyOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({ path: z.string().trim().min(1).default('.') })
export type GitStatusInput = z.infer<typeof InputSchema>

export class GitStatusTool implements Tool<GitStatusInput> {
  readonly name = 'git_status'
  readonly description = 'Return structured Git branch, commit, and working-tree status.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'read' as const

  async execute(input: GitStatusInput, context: ToolContext) {
    pathPolicyOf(context).assertReadable(input.path)
    const root = await context.policy.resolveReadable(input.path)
    const stdout = await gitExec(root, ['status', '--porcelain=v1', '-z', '-uall'])
    const branch = (await gitExec(root, ['branch', '--show-current'])).trim()
    const commit = (await gitExec(root, ['rev-parse', 'HEAD'])).trim()
    return { path: input.path, branch, commit, entries: parseStatus(stdout) }
  }
}

function parseStatus(
  stdout: string,
): Array<{ path: string; status: string; index: string; worktree: string }> {
  const records = stdout.split('\0').filter(Boolean)
  const entries: Array<{ path: string; status: string; index: string; worktree: string }> = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    const status = record.slice(0, 2)
    const source = unquote(record.slice(3))
    if ((status.includes('R') || status.includes('C')) && records[index + 1]) {
      const destination = unquote(records[index + 1] ?? '')
      entries.push({
        path: destination,
        status,
        index: status[0] ?? ' ',
        worktree: status[1] ?? ' ',
      })
      entries.push({ path: source, status, index: status[0] ?? ' ', worktree: status[1] ?? ' ' })
      index += 1
      continue
    }
    entries.push({ path: source, status, index: status[0] ?? ' ', worktree: status[1] ?? ' ' })
  }
  return entries
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replaceAll('\\n', '\n').replaceAll('\\"', '"').replaceAll('\\\\', '\\')
    : value
}
