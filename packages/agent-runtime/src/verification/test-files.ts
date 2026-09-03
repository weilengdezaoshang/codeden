import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { isIgnoredWorkspaceEntry } from '../workspace/ignored-paths.js'

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

export function isTestPath(relPath: string): boolean {
  const posix = relPath.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!posix) {
    return false
  }
  const parts = posix.split('/')
  if (parts.includes('tests') && parts[0] === 'tests' && parts.length > 1) {
    return true
  }
  const base = parts.at(-1) ?? ''
  return TEST_FILE.test(base)
}

export async function listTestFiles(root: string): Promise<string[]> {
  const found: string[] = []
  await walk(root, '', found)
  return found.sort()
}

async function walk(abs: string, prefix: string, found: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (isIgnoredWorkspaceEntry(entry.name)) {
      continue
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const next = path.join(abs, entry.name)
    if (entry.isDirectory()) {
      await walk(next, rel, found)
    } else if (entry.isFile() && isTestPath(rel)) {
      found.push(rel)
    }
  }
}
