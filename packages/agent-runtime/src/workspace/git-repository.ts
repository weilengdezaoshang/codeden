import { execFile } from 'node:child_process'
import { lstat, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { pickCommandEnv } from '../process-env.js'

const execFileAsync = promisify(execFile)

export interface GitRepository {
  toplevel: string
}

export async function detectGit(originRoot: string): Promise<GitRepository | undefined> {
  try {
    const inside = (await gitExec(originRoot, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') {
      return undefined
    }
    const toplevel = await realpath(
      (await gitExec(originRoot, ['rev-parse', '--show-toplevel'])).trim(),
    )
    await gitExec(toplevel, ['rev-parse', '--verify', 'HEAD'])
    return { toplevel }
  } catch {
    return undefined
  }
}

export async function hasGitMetadata(start: string): Promise<boolean> {
  let current = start
  while (true) {
    try {
      await lstat(path.join(current, '.git'))
      return true
    } catch {
      const parent = path.dirname(current)
      if (parent === current) {
        return false
      }
      current = parent
    }
  }
}

export async function gitExec(cwd: string, args: string[]): Promise<string> {
  const env = pickCommandEnv({ HOME: process.env.HOME, TMPDIR: process.env.TMPDIR })
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

export async function dirtyPaths(toplevel: string): Promise<Set<string>> {
  const stdout = await gitExec(toplevel, ['status', '--porcelain', '-z', '-uall'])
  const records = stdout.split('\0').filter((item) => item.length > 0)
  const paths = new Set<string>()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 3) {
      continue
    }
    const code = record.slice(0, 2)
    const first = unquotePath(record.slice(3).replaceAll('\\', '/'))
    if (code.includes('R') || code.includes('C')) {
      const dest = unquotePath((records[index + 1] ?? '').replaceAll('\\', '/'))
      if (first) {
        paths.add(first)
      }
      if (dest) {
        paths.add(dest)
      }
      index += 1
      continue
    }
    if (first) {
      paths.add(first)
    }
  }
  return paths
}

export async function originMatchesHead(
  toplevel: string,
  topRel: string,
  originAbs: string,
  exists: (filePath: string) => Promise<boolean>,
  ref = 'HEAD',
): Promise<boolean> {
  const tracked = await isTrackedPath(toplevel, topRel)
  const originExists = await exists(originAbs)
  if (!tracked) {
    return !originExists
  }
  if (!originExists) {
    return false
  }
  try {
    await gitExec(toplevel, ['diff', '--quiet', ref, '--', topRel])
    return true
  } catch {
    return false
  }
}

async function isTrackedPath(toplevel: string, topRel: string): Promise<boolean> {
  try {
    await gitExec(toplevel, ['ls-files', '--error-unmatch', '--', topRel])
    return true
  } catch {
    return false
  }
}

export function isDirtyPath(topRel: string, dirty: Set<string>): boolean {
  const posix = topRel.replaceAll('\\', '/')
  for (const item of dirty) {
    const candidate = item.replace(/\/$/, '')
    if (
      candidate === posix ||
      posix.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${posix}/`)
    ) {
      return true
    }
  }
  return false
}

export function toTopRel(toplevel: string, originRoot: string, rel: string): string {
  return path.relative(toplevel, path.join(originRoot, rel)).replaceAll('\\', '/')
}

export async function removeWorktree(toplevel: string, worktreeRoot: string): Promise<void> {
  try {
    await gitExec(toplevel, ['worktree', 'remove', '--force', worktreeRoot])
  } catch {
    await rm(worktreeRoot, { recursive: true, force: true })
    try {
      await gitExec(toplevel, ['worktree', 'prune'])
    } catch {
      // Best-effort cleanup.
    }
  }
}

function unquotePath(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
  }
  return value
}
