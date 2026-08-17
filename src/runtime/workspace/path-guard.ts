import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'

export function denyPath(inputPath: string, reason: string): never {
  throw new CodeDenError({
    code: ErrorCodes.WORKSPACE_PATH_DENIED,
    category: 'permission',
    message: reason,
    retryable: false,
    details: { path: inputPath },
  })
}

export async function resolveInsideRoot(root: string, inputPath: string): Promise<string> {
  if (inputPath.length === 0) {
    denyPath(inputPath, 'Path must not be empty')
  }

  const realRoot = await realpath(root)
  const resolved = path.resolve(realRoot, inputPath)

  let candidate = resolved
  try {
    candidate = await realpath(resolved)
  } catch {
    candidate = await resolveThroughExistingParent(resolved)
  }

  const relative = path.relative(realRoot, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    denyPath(inputPath, `Path escapes workspace root: ${inputPath}`)
  }

  return candidate
}

async function resolveThroughExistingParent(target: string): Promise<string> {
  let current = path.dirname(target)
  const suffix: string[] = [path.basename(target)]

  while (true) {
    try {
      const realParent = await realpath(current)
      const joined = path.resolve(realParent, ...suffix.reverse())
      await assertNoSymlinkEscape(current, target, realParent)
      return joined
    } catch (error) {
      if (!isNotFound(error)) {
        throw error
      }
      suffix.push(path.basename(current))
      const parent = path.dirname(current)
      if (parent === current) {
        denyPath(target, `Unable to resolve path: ${target}`)
      }
      current = parent
    }
  }
}

async function assertNoSymlinkEscape(
  startDir: string,
  target: string,
  realParent: string,
): Promise<void> {
  let cursor = startDir
  while (cursor.startsWith(realParent) || path.relative(realParent, cursor) === '') {
    try {
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink()) {
        const linked = await realpath(cursor)
        if (
          path.relative(realParent, linked).startsWith('..') ||
          path.isAbsolute(path.relative(realParent, linked))
        ) {
          denyPath(target, `Symlink escapes workspace root: ${target}`)
        }
      }
    } catch {
      break
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      break
    }
    cursor = parent
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
