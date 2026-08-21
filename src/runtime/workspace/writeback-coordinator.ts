import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { SecretLeakGuard } from '../../security/secret-leak-guard.js'
import type { SecretRedactor } from '../../security/secret-redactor.js'
import { SensitivePathPolicy } from '../../security/sensitive-path-policy.js'
import { writeConflictPatch } from './conflict-patch.js'
import { dirtyPaths, isDirtyPath, originMatchesHead, toTopRel } from './git-repository.js'
import { isIgnoredWorkspacePath } from './ignored-paths.js'
import { assertSafeRelativePath, exists, uniquePaths } from './workspace-boundary.js'

export interface WritebackResult {
  applied: string[]
  conflicts: string[]
  patchPath?: string
}

export async function applyWorkspaceChanges(input: {
  originRoot: string
  workspaceRoot: string
  toplevel: string
  changedPaths: string[]
  redactor?: SecretRedactor
  guard?: SecretLeakGuard
}): Promise<WritebackResult> {
  const sensitive = new SensitivePathPolicy()
  const dirty = await dirtyPaths(input.toplevel)
  const applied: string[] = []
  const conflicts: string[] = []

  for (const rel of uniquePaths(input.changedPaths)) {
    const posix = rel.replaceAll('\\', '/')
    const result = await applyOnePath({ ...input, posix, dirty, sensitive })
    if (result === 'applied') {
      applied.push(posix)
    } else {
      conflicts.push(posix)
    }
  }

  const patchPath = await writeConflictPatch({
    originRoot: input.originRoot,
    worktreeRoot: input.workspaceRoot,
    conflicts,
    redactor: input.redactor,
    guard: input.guard,
  })
  return {
    applied: applied.sort(),
    conflicts: conflicts.sort(),
    ...(patchPath ? { patchPath } : {}),
  }
}

async function applyOnePath(input: {
  originRoot: string
  workspaceRoot: string
  toplevel: string
  posix: string
  dirty: Set<string>
  sensitive: SensitivePathPolicy
}): Promise<'applied' | 'conflict'> {
  await assertSafeRelativePath(input.originRoot, input.posix)
  await assertSafeRelativePath(input.workspaceRoot, input.posix)
  if (input.sensitive.isSensitive(input.posix) || isIgnoredWorkspacePath(input.posix)) {
    return 'conflict'
  }

  const originAbs = path.join(input.originRoot, input.posix)
  const sourceAbs = path.join(input.workspaceRoot, input.posix)
  const topRel = toTopRel(input.toplevel, input.originRoot, input.posix)
  const latestDirty =
    isDirtyPath(topRel, input.dirty) || isDirtyPath(topRel, await dirtyPaths(input.toplevel))
  if (
    latestDirty ||
    !(await exists(sourceAbs)) ||
    !(await originMatchesHead(input.toplevel, topRel, originAbs, exists))
  ) {
    return 'conflict'
  }

  await readFile(sourceAbs)
  if (!(await originMatchesHead(input.toplevel, topRel, originAbs, exists))) {
    return 'conflict'
  }
  return atomicallyReplace({ sourceAbs, originAbs, toplevel: input.toplevel, topRel })
}

async function atomicallyReplace(input: {
  sourceAbs: string
  originAbs: string
  toplevel: string
  topRel: string
}): Promise<'applied' | 'conflict'> {
  await mkdir(path.dirname(input.originAbs), { recursive: true })
  const stagingDir = await mkdtemp(path.join(path.dirname(input.originAbs), '.codeden-write-'))
  const stagingPath = path.join(stagingDir, path.basename(input.originAbs))
  try {
    await copyFile(input.sourceAbs, stagingPath)
    if (!(await originMatchesHead(input.toplevel, input.topRel, input.originAbs, exists))) {
      return 'conflict'
    }
    await rename(stagingPath, input.originAbs)
    return 'applied'
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}
