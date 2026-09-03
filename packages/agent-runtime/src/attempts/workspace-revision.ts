import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { CodeDenError, parseWithSchema } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import { digestFile } from '../workspace/apply-plan.js'
import { isIgnoredWorkspacePath } from '../workspace/ignored-paths.js'
import { assertSafeRelativePath } from '@codeden/core/filesystem/workspace-boundary.js'

const RevisionFileSchema = z
  .object({
    path: z.string().min(1),
    exists: z.boolean(),
    type: z.enum(['file', 'directory', 'symlink']).optional(),
    mode: z.number().int().nonnegative().optional(),
    size: z.number().int().nonnegative().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    linkTarget: z.string().optional(),
  })
  .superRefine((file, context) => {
    if (!isCanonicalRelativePath(file.path)) {
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'Revision path is not canonical',
      })
    }
    if (!file.exists) {
      if (
        file.type !== undefined ||
        file.mode !== undefined ||
        file.size !== undefined ||
        file.sha256 !== undefined ||
        file.linkTarget !== undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Missing revision file cannot have file metadata',
        })
      }
      return
    }
    if (file.type === undefined || file.mode === undefined || file.size === undefined) {
      context.addIssue({ code: 'custom', message: 'Existing revision file requires metadata' })
    }
    if ((file.type === 'file' || file.type === 'directory') && file.sha256 === undefined) {
      context.addIssue({ code: 'custom', path: ['sha256'], message: 'File digest is required' })
    }
    if (file.type === 'symlink' && file.linkTarget === undefined) {
      context.addIssue({ code: 'custom', path: ['linkTarget'], message: 'Link target is required' })
    }
  })

export const WorkspaceRevisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    baseCommit: z.string().min(1).optional(),
    files: z.array(RevisionFileSchema),
  })
  .superRefine((revision, context) => {
    const paths = revision.files.map((file) => file.path)
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Revision paths must be unique',
      })
    }
    const sorted = [...paths].sort()
    if (paths.some((item, index) => item !== sorted[index])) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Revision paths must be sorted',
      })
    }
  })

export type WorkspaceRevision = z.infer<typeof WorkspaceRevisionSchema>

export async function captureWorkspaceRevision(input: {
  root: string
  changedPaths: readonly string[]
  baseCommit?: string
}): Promise<WorkspaceRevision> {
  const changedPaths = [...new Set(input.changedPaths.map(normalizeChangedPath))]
    .filter((item) => !isIgnoredWorkspacePath(item))
    .sort()
  const files = []
  for (const relativePath of changedPaths) {
    await assertSafeRelativePath(input.root, relativePath)
    files.push(await digestFile(path.join(input.root, relativePath), relativePath))
  }
  const payload = {
    schemaVersion: 1 as const,
    ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
    files,
  }
  return { ...payload, id: computeRevisionId(payload) }
}

export function parseWorkspaceRevision(input: unknown): WorkspaceRevision {
  const revision = parseWithSchema(WorkspaceRevisionSchema, input, 'Invalid workspace revision')
  const expected = computeRevisionId(revision)
  if (revision.id !== expected) {
    throw new CodeDenError({
      code: ErrorCodes.INVALID_INPUT,
      category: 'validation',
      message: 'Workspace revision digest does not match its manifest',
      retryable: false,
    })
  }
  return revision
}

function computeRevisionId(input: Omit<WorkspaceRevision, 'id'> | WorkspaceRevision): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: input.schemaVersion,
        baseCommit: input.baseCommit ?? null,
        files: input.files,
      }),
    )
    .digest('hex')
}

function normalizeChangedPath(value: string): string {
  const posix = value.replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (path.posix.isAbsolute(posix) || path.win32.isAbsolute(value)) {
    return value
  }
  return path.posix.normalize(posix)
}

function isCanonicalRelativePath(value: string): boolean {
  if (
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.normalize(value) !== value
  ) {
    return false
  }
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}
