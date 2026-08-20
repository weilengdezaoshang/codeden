import path from 'node:path'
import { CodeDenError } from '../core/errors/codeden-error.js'
import { ErrorCodes } from '../core/errors/error-codes.js'

const SENSITIVE_BASENAMES = new Set(['.env', 'credentials.json', 'secrets.json'])
const SENSITIVE_SUFFIXES = ['.codeden/config.local.yaml', '.aws/credentials', '.grok/auth.json']
const SENSITIVE_DIR_PREFIXES = ['.ssh/', '.aws/', '.config/gcloud/', '.codeden/', '.grok/']
const STRING_LITERAL = /(['"])([^'"]+)\1/g

export class SensitivePathPolicy {
  assertReadable(inputPath: string): void {
    if (this.isSensitive(inputPath)) {
      deny()
    }
  }

  assertWritable(inputPath: string): void {
    if (this.isSensitive(inputPath)) {
      deny()
    }
  }

  assertCommand(command: string, args: string[] = []): void {
    for (const token of commandPathTokens(command, args)) {
      if (this.isSensitive(token)) {
        deny()
      }
    }
  }

  isSensitive(inputPath: string): boolean {
    const normalized = normalizeRel(inputPath)
    if (!normalized) {
      return false
    }

    const parts = normalized.split('/').filter((part) => part.length > 0 && part !== '.')
    const posix = parts.join('/')
    const base = parts.at(-1) ?? ''

    if (base === '.env' || base.startsWith('.env.')) {
      return true
    }
    if (SENSITIVE_BASENAMES.has(base)) {
      return true
    }
    if (base.endsWith('.pem') || base.endsWith('.key')) {
      return true
    }
    if (SENSITIVE_SUFFIXES.some((suffix) => posix === suffix || posix.endsWith(`/${suffix}`))) {
      return true
    }
    return SENSITIVE_DIR_PREFIXES.some(
      (prefix) =>
        posix === prefix.slice(0, -1) || posix.startsWith(prefix) || posix.includes(`/${prefix}`),
    )
  }
}

function commandPathTokens(command: string, args: string[]): string[] {
  const tokens = [command, ...args]
  const extracted: string[] = []
  for (const token of tokens) {
    extracted.push(token)
    for (const match of token.matchAll(STRING_LITERAL)) {
      const value = match[2]
      if (value) {
        extracted.push(value)
      }
    }
  }
  return extracted
}

function normalizeRel(inputPath: string): string {
  const posix = inputPath.replaceAll('\\', '/')
  let normalized = path.posix.normalize(posix)
  normalized = normalized.replace(/^\/+/, '').replace(/^\.\/+/, '')
  if (normalized === '.' || normalized === '') {
    return ''
  }
  return normalized
}

function deny(): never {
  throw new CodeDenError({
    code: ErrorCodes.WORKSPACE_SECRET_PATH_DENIED,
    category: 'permission',
    message: '读取敏感配置文件被安全策略拒绝',
    retryable: false,
  })
}

export function toPosixRel(workspaceRoot: string, absPath: string): string {
  return path.relative(workspaceRoot, absPath).split(path.sep).join('/')
}
