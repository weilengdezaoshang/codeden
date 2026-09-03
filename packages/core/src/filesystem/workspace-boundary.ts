import { lstat, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { CodeDenError } from '../errors/codeden-error.js'
import { ErrorCodes } from '../errors/error-codes.js'

export async function assertSafeRelativePath(root: string, relativePath: string): Promise<void> {
  const normalized = relativePath.replaceAll('\\', '/')
  if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(relativePath)) {
    throw workspacePathDenied(relativePath)
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..' || part === '')) {
    throw workspacePathDenied(relativePath)
  }
  const resolvedRoot = await realpath(root)
  const absolute = path.resolve(resolvedRoot, ...parts)
  if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw workspacePathDenied(relativePath)
  }
  let cursor = absolute
  while (cursor !== resolvedRoot && cursor.startsWith(`${resolvedRoot}${path.sep}`)) {
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) {
        throw workspacePathDenied(relativePath)
      }
    } catch (error) {
      if (isPathMissing(error)) {
        cursor = path.dirname(cursor)
        continue
      }
      throw error
    }
    cursor = path.dirname(cursor)
  }
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export function uniquePaths(items: string[]): string[] {
  return [...new Set(items.map((item) => item.replaceAll('\\', '/')))]
}

function workspacePathDenied(relativePath: string): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.WORKSPACE_PATH_DENIED,
    category: 'permission',
    message: `Write-back path denied: ${relativePath}`,
    retryable: false,
  })
}

function isPathMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
