import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SensitivePathPolicy } from '../../security/sensitive-path-policy.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import type { SecretLeakGuard } from '../../security/secret-leak-guard.js'
import type { SecretRedactor } from '../../security/secret-redactor.js'
import { isIgnoredWorkspacePath } from './ignored-paths.js'
import { createFileDiff } from './patch-diff.js'
const sensitive = new SensitivePathPolicy()

export const LAST_PATCH_REL = path.join('.codeden', 'last.patch')

export async function validateConflictPatch(input: {
  originRoot: string
  worktreeRoot: string
  conflicts: string[]
  redactor?: SecretRedactor
  guard?: SecretLeakGuard
}): Promise<void> {
  await buildSafePatch(input)
}

export async function writeConflictPatch(input: {
  originRoot: string
  worktreeRoot: string
  conflicts: string[]
  redactor?: SecretRedactor
  guard?: SecretLeakGuard
}): Promise<string | undefined> {
  if (input.conflicts.length === 0) {
    await rm(path.join(input.originRoot, LAST_PATCH_REL), { force: true })
    return undefined
  }

  const safePatch = await buildSafePatch(input)
  if (!safePatch) {
    return undefined
  }

  const patchPath = path.join(input.originRoot, LAST_PATCH_REL)
  await mkdir(path.dirname(patchPath), { recursive: true })
  const stagingDir = await mkdtemp(path.join(path.dirname(patchPath), '.codeden-patch-'))
  const stagingPath = path.join(stagingDir, 'last.patch')
  try {
    await writeFile(stagingPath, safePatch, 'utf8')
    await rename(stagingPath, patchPath)
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
  return patchPath
}

async function buildSafePatch(input: {
  originRoot: string
  worktreeRoot: string
  conflicts: string[]
  redactor?: SecretRedactor
  guard?: SecretLeakGuard
}): Promise<string | undefined> {
  const chunks: string[] = []
  for (const rel of input.conflicts) {
    if (sensitive.isSensitive(rel) || isIgnoredWorkspacePath(rel)) {
      continue
    }
    const fromAbs = path.join(input.originRoot, rel)
    const toAbs = path.join(input.worktreeRoot, rel)
    const diff = await createFileDiff(rel, fromAbs, toAbs)
    if (diff.trim()) {
      chunks.push(diff.trimEnd())
    }
  }
  if (chunks.length === 0) {
    return undefined
  }

  const patch = `${chunks.join('\n')}\n`
  input.guard?.assertSafe(patch, 'conflict patch')
  const safePatch = input.redactor?.redact(patch) ?? patch
  input.guard?.assertSafe(safePatch, 'redacted conflict patch')

  const MAX_PATCH_BYTES = 4 * 1024 * 1024
  if (Buffer.byteLength(safePatch, 'utf8') > MAX_PATCH_BYTES) {
    throw new CodeDenError({
      code: ErrorCodes.SUBMISSION_INVALID,
      category: 'validation',
      message: 'Conflict patch exceeds the maximum supported size',
      retryable: false,
    })
  }
  return safePatch
}

export async function removeConflictPatch(originRoot: string): Promise<void> {
  await rm(path.join(originRoot, LAST_PATCH_REL), { force: true })
}
