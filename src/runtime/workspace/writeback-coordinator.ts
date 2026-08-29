import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { SecretLeakGuard } from '../../security/secret-leak-guard.js'
import type { SecretRedactor } from '../../security/secret-redactor.js'
import { SensitivePathPolicy } from '../../security/sensitive-path-policy.js'
import { buildApplyPlan, digestFile, sameFileDigest, type FileDigest } from './apply-plan.js'
import { validateConflictPatch, writeConflictPatch } from './conflict-patch.js'
import { dirtyPaths, isDirtyPath, originMatchesHead, toTopRel } from './git-repository.js'
import { isIgnoredWorkspacePath } from './ignored-paths.js'
import { assertSafeRelativePath, exists, uniquePaths } from './workspace-boundary.js'
import { workspaceRevisionStale } from './writeback-gate.js'

export interface WritebackResult {
  applied: string[]
  unchanged: string[]
  conflicts: string[]
  patchPath?: string
}

interface PendingApply {
  posix: string
  topRel: string
  originAbs: string
  sourceAbs: string
  base: FileDigest
  candidate: FileDigest
  stagePath?: string
  backupPath?: string
}

export async function applyWorkspaceChanges(input: {
  originRoot: string
  workspaceRoot: string
  toplevel: string
  changedPaths: string[]
  baseRef?: string
  baselineDigests?: ReadonlyMap<string, FileDigest>
  expectedCandidateDigests?: ReadonlyMap<string, FileDigest>
  redactor?: SecretRedactor
  guard?: SecretLeakGuard
}): Promise<WritebackResult> {
  const sensitive = new SensitivePathPolicy()
  const dirty = await dirtyPaths(input.toplevel)
  const applied: string[] = []
  const unchanged: string[] = []
  const conflicts: string[] = []
  const pending: PendingApply[] = []

  for (const rel of uniquePaths(input.changedPaths)) {
    const posix = rel.replaceAll('\\', '/')
    const result = await inspectPath({ ...input, posix, dirty, sensitive })
    if (result.kind === 'pending' && result.entry) {
      pending.push(result.entry)
    } else if (result.kind === 'unchanged') {
      unchanged.push(posix)
    } else {
      conflicts.push(posix)
    }
  }

  if (
    pending.length > 0 &&
    !(await verifyPendingOrigins(input.toplevel, pending, input.baseRef, input.baselineDigests))
  ) {
    // 基线发生变化时，当前批次必须整体转为冲突，不能只应用其中一部分。
    conflicts.push(...pending.map((entry) => entry.posix))
    pending.length = 0
  }

  if (conflicts.length > 0 && pending.length > 0) {
    // 批次中已有冲突时，其余待应用文件也必须随批次一起保留，不得部分写回。
    conflicts.push(...pending.map((entry) => entry.posix))
    pending.length = 0
  }

  if (conflicts.length > 0) {
    // 任意冲突都会阻止整批写回，先校验完整 Patch，再生成冲突结果。
    await validateConflictPatch({
      originRoot: input.originRoot,
      worktreeRoot: input.workspaceRoot,
      conflicts,
      redactor: input.redactor,
      guard: input.guard,
    })
    const patchPath = await writeConflictPatch({
      originRoot: input.originRoot,
      worktreeRoot: input.workspaceRoot,
      conflicts,
      redactor: input.redactor,
      guard: input.guard,
    })
    return {
      applied: [],
      unchanged: unchanged.sort(),
      conflicts: [...new Set(conflicts)].sort(),
      ...(patchPath ? { patchPath } : {}),
    }
  }

  if (pending.length > 0) {
    await applyPendingAtomically(input.originRoot, pending)
    applied.push(...pending.map((entry) => entry.posix))
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
    unchanged: unchanged.sort(),
    conflicts: [...new Set(conflicts)].sort(),
    ...(patchPath ? { patchPath } : {}),
  }
}

async function inspectPath(input: {
  originRoot: string
  workspaceRoot: string
  toplevel: string
  posix: string
  dirty: Set<string>
  sensitive: SensitivePathPolicy
  baseRef?: string
  baselineDigests?: ReadonlyMap<string, FileDigest>
  expectedCandidateDigests?: ReadonlyMap<string, FileDigest>
}): Promise<{ kind: 'pending' | 'unchanged' | 'conflict'; entry?: PendingApply }> {
  await assertSafeRelativePath(input.originRoot, input.posix)
  await assertSafeRelativePath(input.workspaceRoot, input.posix)
  if (input.sensitive.isSensitive(input.posix) || isIgnoredWorkspacePath(input.posix)) {
    return { kind: 'conflict' }
  }

  const originAbs = path.join(input.originRoot, input.posix)
  const sourceAbs = path.join(input.workspaceRoot, input.posix)
  const topRel = toTopRel(input.toplevel, input.originRoot, input.posix)
  const base = input.baselineDigests?.get(input.posix) ?? (await digestFile(originAbs, input.posix))
  const candidate = await digestFile(sourceAbs, input.posix)
  const expectedCandidate = input.expectedCandidateDigests?.get(input.posix)
  if (expectedCandidate && !sameFileDigest(expectedCandidate, candidate)) {
    throw workspaceRevisionStale(
      expectedCandidate.sha256 ?? String(expectedCandidate.exists),
      candidate.sha256 ?? String(candidate.exists),
    )
  }
  const current = await digestFile(originAbs, input.posix)
  const plan = buildApplyPlan([{ base, current, candidate }])[0]
  if (!plan) {
    return { kind: 'conflict' }
  }

  const ownedBySession = input.baselineDigests?.has(input.posix) ?? false
  const originClean = ownedBySession
    ? sameFileDigest(base, current)
    : await originMatchesHead(input.toplevel, topRel, originAbs, exists, input.baseRef)
  const dirtyConflict = ownedBySession
    ? !sameFileDigest(base, current)
    : isDirtyPath(topRel, input.dirty)
  if (dirtyConflict || !originClean || plan.kind === 'conflict') {
    return { kind: 'conflict' }
  }
  if (plan.kind === 'unchanged') {
    return { kind: 'unchanged' }
  }

  // 当前写回事务支持普通文件和普通文件删除；目录、符号链接等语义需要单独策略。
  if ((candidate.exists && candidate.type !== 'file') || (base.exists && base.type !== 'file')) {
    return { kind: 'conflict' }
  }
  return {
    kind: 'pending',
    entry: { posix: input.posix, topRel, originAbs, sourceAbs, base, candidate },
  }
}

async function verifyPendingOrigins(
  toplevel: string,
  pending: PendingApply[],
  baseRef?: string,
  baselineDigests?: ReadonlyMap<string, FileDigest>,
): Promise<boolean> {
  for (const entry of pending) {
    const current = await digestFile(entry.originAbs, entry.posix)
    if (!sameFileDigest(current, entry.base)) {
      return false
    }
    if (
      !(await originMatchesHead(toplevel, entry.topRel, entry.originAbs, exists, baseRef)) &&
      !(baselineDigests?.has(entry.posix) ?? false)
    ) {
      return false
    }
  }
  return true
}

async function applyPendingAtomically(originRoot: string, pending: PendingApply[]): Promise<void> {
  const stagingRoot = await mkdtemp(path.join(path.dirname(originRoot), '.codeden-write-'))
  try {
    await stageCandidates(stagingRoot, pending)
    try {
      await backupOrigins(stagingRoot, pending)
      await commitCandidates(pending)
    } catch (error) {
      await rollbackCandidates(pending)
      throw error
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

async function stageCandidates(stagingRoot: string, pending: PendingApply[]): Promise<void> {
  for (const entry of pending) {
    if (!entry.candidate.exists) {
      const current = await digestFile(entry.sourceAbs, entry.posix)
      if (!sameFileDigest(current, entry.candidate)) {
        throw workspaceRevisionStale(
          String(entry.candidate.exists),
          current.sha256 ?? String(current.exists),
        )
      }
      continue
    }
    const stagePath = path.join(stagingRoot, 'candidate', ...entry.posix.split('/'))
    await mkdir(path.dirname(stagePath), { recursive: true })
    await copyFile(entry.sourceAbs, stagePath)
    if (entry.candidate.mode !== undefined) {
      await chmod(stagePath, entry.candidate.mode)
    }
    entry.stagePath = stagePath
    const staged = await digestFile(stagePath, entry.posix)
    if (!sameFileDigest(staged, entry.candidate)) {
      throw workspaceRevisionStale(
        entry.candidate.sha256 ?? String(entry.candidate.exists),
        staged.sha256 ?? String(staged.exists),
      )
    }
  }
}

async function backupOrigins(stagingRoot: string, pending: PendingApply[]): Promise<void> {
  for (const entry of pending) {
    if (!(await exists(entry.originAbs))) {
      continue
    }
    const backupPath = path.join(stagingRoot, 'backup', ...entry.posix.split('/'))
    await mkdir(path.dirname(backupPath), { recursive: true })
    await rename(entry.originAbs, backupPath)
    entry.backupPath = backupPath
  }
}

async function commitCandidates(pending: PendingApply[]): Promise<void> {
  for (const entry of pending) {
    if (!entry.candidate.exists || !entry.stagePath) {
      continue
    }
    await mkdir(path.dirname(entry.originAbs), { recursive: true })
    await rename(entry.stagePath, entry.originAbs)
  }
}

async function rollbackCandidates(pending: PendingApply[]): Promise<void> {
  for (const entry of [...pending].reverse()) {
    if (entry.candidate.exists) {
      await rm(entry.originAbs, { recursive: true, force: true })
    }
    if (entry.backupPath && (await exists(entry.backupPath))) {
      await mkdir(path.dirname(entry.originAbs), { recursive: true })
      await rename(entry.backupPath, entry.originAbs)
    }
  }
}
