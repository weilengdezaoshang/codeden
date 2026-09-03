import { createHash } from 'node:crypto'

const TAP_NOT_OK = /^\s*not ok \d+ - (.+)$/gm
const VITEST_FAIL = /^\s*FAIL\s+(\S+)/gm
const TAP_LOCATION = /location:\s+['"]([^'"]+\.(?:test|spec)\.[^'"\s:]+)/g

export function parseFailingIdentities(output: string): string[] {
  const identities = new Set<string>()
  const text = stripAnsi(output)
  for (const match of text.matchAll(TAP_NOT_OK)) {
    const value = match[1]?.trim()
    if (value) {
      identities.add(stripTapSuffix(value))
    }
  }
  for (const match of text.matchAll(VITEST_FAIL)) {
    const value = match[1]?.trim()
    if (value) {
      identities.add(value)
    }
  }
  for (const match of text.matchAll(TAP_LOCATION)) {
    const value = match[1]?.trim()
    if (value) {
      identities.add(value)
    }
  }
  return [...identities].sort()
}

export function fingerprintOutput(output: string): string {
  const normalized = normalizeOutput(output)
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export function normalizeOutput(output: string): string {
  return stripAnsi(output)
    .replace(/\r\n/g, '\n')
    .replace(/duration_ms:\s*\d+(?:\.\d+)?/g, 'duration_ms: ms')
    .replace(/\d+(?:\.\d+)?\s*m?s\b/g, 'ms')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function stripTapSuffix(value: string): string {
  return value.replace(/\s+# .*$/, '').trim()
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}
