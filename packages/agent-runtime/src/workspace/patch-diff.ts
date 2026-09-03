import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { pickCommandEnv } from '../process-env.js'

const execFileAsync = promisify(execFile)

export async function createFileDiff(rel: string, fromAbs: string, toAbs: string): Promise<string> {
  const fromBytes = await readOptional(fromAbs)
  const toBytes = await readOptional(toAbs)
  if ((fromBytes && isBinary(fromBytes)) || (toBytes && isBinary(toBytes))) {
    throw new CodeDenError({
      code: ErrorCodes.SUBMISSION_INVALID,
      category: 'validation',
      message: `Binary conflict cannot be represented as a text patch: ${rel}`,
      retryable: false,
    })
  }
  const from = fromBytes?.toString('utf8') ?? ''
  const to = toBytes?.toString('utf8') ?? ''
  if (from === to) {
    return ''
  }
  try {
    await execFileAsync(
      'git',
      ['-c', 'core.quotepath=false', 'diff', '--no-index', '--', fromAbs, toAbs],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: pickCommandEnv({ HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }),
      },
    )
    return ''
  } catch (error) {
    const stdout =
      error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : ''
    return stdout.trim() ? relativizeDiff(stdout, rel) : fallbackDiff(rel, from, to)
  }
}

function relativizeDiff(raw: string, rel: string): string {
  return raw
    .replace(/^diff --git .+$/m, `diff --git a/${rel} b/${rel}`)
    .replace(/^--- (?!\/dev\/null).+$/m, `--- a/${rel}`)
    .replace(/^\+\+\+ (?!\/dev\/null).+$/m, `+++ b/${rel}`)
}

function fallbackDiff(rel: string, from: string, to: string): string {
  const oldLines = from.split('\n')
  const newLines = to.split('\n')
  return [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n')
}

async function readOptional(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath)
  } catch {
    return undefined
  }
}

function isBinary(value: Buffer): boolean {
  return value.includes(0)
}
