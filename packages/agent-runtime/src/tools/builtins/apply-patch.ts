import { readFile, writeFile, mkdir, rm, lstat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { guardOf, pathPolicyOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({ patch: z.string().min(1).max(4_000_000) })
export type ApplyPatchInput = z.infer<typeof InputSchema>

type PatchOperation =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'update'; path: string; hunks: PatchHunk[]; moveTo?: string }
  | { kind: 'delete'; path: string }

interface PatchHunk {
  lines: string[]
}

export class ApplyPatchTool implements Tool<ApplyPatchInput> {
  readonly name = 'apply_patch'
  readonly description =
    'Apply a multi-file patch. Supports adding, updating, deleting, and moving workspace files using the *** Begin Patch format.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'write' as const

  async execute(input: ApplyPatchInput, context: ToolContext) {
    const operations = parsePatch(input.patch)
    const resolved = await Promise.all(
      operations.map(async (operation) => {
        const source = await context.policy.resolveWritable(operation.path)
        pathPolicyOf(context).assertWritable(operation.path)
        let destination: string | undefined
        if (operation.kind === 'update' && operation.moveTo) {
          pathPolicyOf(context).assertWritable(operation.moveTo)
          destination = await context.policy.resolveWritable(operation.moveTo)
        }
        return { operation, source, destination }
      }),
    )

    const changes: Array<{ path: string; kind: 'added' | 'modified' | 'deleted' | 'moved' }> = []
    for (const item of resolved) {
      const { operation, source, destination } = item
      if (operation.kind === 'add') {
        await assertMissing(source, operation.path)
        assertSafeContent(operation.content, context)
        await mkdir(path.dirname(source), { recursive: true })
        await writeFile(source, operation.content, 'utf8')
        changes.push({ path: operation.path, kind: 'added' })
        continue
      }
      if (operation.kind === 'delete') {
        await assertRegularFile(source, operation.path)
        await rm(source)
        changes.push({ path: operation.path, kind: 'deleted' })
        continue
      }

      await assertRegularFile(source, operation.path)
      const original = await readFile(source, 'utf8')
      const updated = applyHunks(original, operation.hunks, operation.path)
      assertSafeContent(updated, context)
      if (destination) {
        await assertMissing(destination, operation.moveTo ?? '')
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, updated, 'utf8')
        await rm(source)
        changes.push({ path: operation.path, kind: 'moved' })
      } else {
        await writeFile(source, updated, 'utf8')
        changes.push({ path: operation.path, kind: 'modified' })
      }
    }
    return { changes }
  }
}

function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') {
    throw invalidPatch('Patch must start with *** Begin Patch and end with *** End Patch')
  }
  const operations: PatchOperation[] = []
  let index = 1
  while (index < lines.length - 1) {
    const header = lines[index] ?? ''
    if (header.startsWith('*** Add File: ')) {
      const filePath = header.slice('*** Add File: '.length).trim()
      const content: string[] = []
      index += 1
      while (index < lines.length - 1 && !isOperationHeader(lines[index] ?? '')) {
        const line = lines[index] ?? ''
        if (!line.startsWith('+')) {
          throw invalidPatch(`Added file lines must start with +: ${filePath}`)
        }
        content.push(line.slice(1))
        index += 1
      }
      operations.push({ kind: 'add', path: filePath, content: content.join('\n') })
      continue
    }
    if (header.startsWith('*** Delete File: ')) {
      operations.push({ kind: 'delete', path: header.slice('*** Delete File: '.length).trim() })
      index += 1
      continue
    }
    if (header.startsWith('*** Update File: ')) {
      const filePath = header.slice('*** Update File: '.length).trim()
      let moveTo: string | undefined
      index += 1
      if ((lines[index] ?? '').startsWith('*** Move to: ')) {
        moveTo = (lines[index] ?? '').slice('*** Move to: '.length).trim()
        index += 1
      }
      const hunks: PatchHunk[] = []
      while (index < lines.length - 1 && !isOperationHeader(lines[index] ?? '')) {
        const marker = lines[index] ?? ''
        if (!marker.startsWith('@@')) {
          throw invalidPatch(`Update hunk is missing @@: ${filePath}`)
        }
        index += 1
        const hunk: string[] = []
        while (index < lines.length - 1) {
          const line = lines[index] ?? ''
          if (line.startsWith('@@') || isOperationHeader(line)) {
            break
          }
          if (
            line !== '*** End of File' &&
            !line.startsWith(' ') &&
            !line.startsWith('-') &&
            !line.startsWith('+')
          ) {
            throw invalidPatch(`Invalid update line in ${filePath}`)
          }
          if (line !== '*** End of File') {
            hunk.push(line)
          }
          index += 1
        }
        hunks.push({ lines: hunk })
      }
      if (hunks.length === 0) {
        throw invalidPatch(`Update file has no hunks: ${filePath}`)
      }
      operations.push({ kind: 'update', path: filePath, hunks, ...(moveTo ? { moveTo } : {}) })
      continue
    }
    throw invalidPatch(`Unknown patch operation: ${header}`)
  }
  if (operations.length === 0) {
    throw invalidPatch('Patch contains no file operations')
  }
  return operations
}

function applyHunks(original: string, hunks: PatchHunk[], filePath: string): string {
  const hasTrailingNewline = original.endsWith('\n')
  let lines = original.split('\n')
  if (hasTrailingNewline) {
    lines = lines.slice(0, -1)
  }
  let cursor = 0
  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => !line.startsWith('+')).map((line) => line.slice(1))
    const newLines = hunk.lines.filter((line) => !line.startsWith('-')).map((line) => line.slice(1))
    const position = findBlock(lines, oldLines, cursor)
    if (position < 0) {
      throw invalidPatch(`Patch context did not match ${filePath}`)
    }
    lines.splice(position, oldLines.length, ...newLines)
    cursor = position + newLines.length
  }
  return lines.join('\n') + (hasTrailingNewline ? '\n' : '')
}

function findBlock(lines: string[], block: string[], start: number): number {
  if (block.length === 0) {
    return start
  }
  for (let index = start; index <= lines.length - block.length; index += 1) {
    if (block.every((line, offset) => lines[index + offset] === line)) {
      return index
    }
  }
  return -1
}

function isOperationHeader(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Update File: ') ||
    line.startsWith('*** Delete File: ')
  )
}

async function assertMissing(filePath: string, displayPath: string): Promise<void> {
  try {
    await lstat(filePath)
  } catch (error) {
    if (isMissing(error)) {
      return
    }
    throw error
  }
  throw invalidPatch(`Target already exists: ${displayPath}`)
}

async function assertRegularFile(filePath: string, displayPath: string): Promise<void> {
  const info = await lstat(filePath).catch((error: unknown) => {
    if (isMissing(error)) {
      throw invalidPatch(`File does not exist: ${displayPath}`)
    }
    throw error
  })
  if (!info.isFile()) {
    throw invalidPatch(`Only regular files are supported: ${displayPath}`)
  }
}

function assertSafeContent(content: string, context: ToolContext): void {
  guardOf(context).assertSafe(content, 'tool:apply_patch')
}

function invalidPatch(message: string): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.TOOL_INPUT_INVALID,
    category: 'validation',
    message,
    retryable: false,
  })
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
