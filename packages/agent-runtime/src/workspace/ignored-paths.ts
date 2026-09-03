const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
])

export function isIgnoredWorkspacePath(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (
    normalized === '.codeden/traces' ||
    normalized.startsWith('.codeden/traces/') ||
    normalized === '.codeden/telemetry' ||
    normalized.startsWith('.codeden/telemetry/')
  ) {
    return true
  }
  return normalized.split('/').some((part) => IGNORED_DIR_NAMES.has(part))
}

export function isIgnoredWorkspaceEntry(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name)
}
