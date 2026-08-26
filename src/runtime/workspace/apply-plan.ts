import { createHash } from 'node:crypto'
import { lstat, open, readlink } from 'node:fs/promises'

export interface FileDigest {
  readonly path: string
  readonly exists: boolean
  readonly type?: 'file' | 'directory' | 'symlink'
  readonly mode?: number
  readonly size?: number
  readonly sha256?: string
  readonly linkTarget?: string
}

export async function digestFile(filePath: string, relativePath = filePath): Promise<FileDigest> {
  let stat
  try {
    stat = await lstat(filePath)
  } catch (error) {
    if (isMissing(error)) {
      return { path: relativePath, exists: false }
    }
    throw error
  }
  const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file'
  const digest: FileDigest = {
    path: relativePath,
    exists: true,
    type,
    mode: stat.mode & 0o7777,
    size: stat.size,
  }
  if (type === 'symlink') {
    return { ...digest, linkTarget: await readlink(filePath) }
  }
  if (type !== 'file') {
    return digest
  }
  const handle = await open(filePath, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) {
      return { ...digest, type: opened.isSymbolicLink() ? 'symlink' : 'directory' }
    }
    const content = await handle.readFile()
    return { ...digest, sha256: createHash('sha256').update(content).digest('hex') }
  } finally {
    await handle.close()
  }
}

export type ChangeKind = 'unchanged' | 'added' | 'modified' | 'deleted' | 'conflict'

export function classifyChange(
  base: FileDigest,
  current: FileDigest,
  candidate: FileDigest,
): ChangeKind {
  if (!sameDigest(base, current)) {
    return 'conflict'
  }
  if (sameDigest(base, candidate)) {
    return 'unchanged'
  }
  if (!base.exists && candidate.exists) {
    return 'added'
  }
  if (base.exists && !candidate.exists) {
    return 'deleted'
  }
  return 'modified'
}

function sameDigest(left: FileDigest, right: FileDigest): boolean {
  return (
    left.path === right.path &&
    left.exists === right.exists &&
    left.type === right.type &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.linkTarget === right.linkTarget
  )
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
