import { z, type ZodType } from 'zod'
import { ErrorCodes } from './error-codes.js'

export const CodeDenErrorCategorySchema = z.enum([
  'validation',
  'model',
  'tool',
  'workspace',
  'permission',
  'timeout',
  'verifier',
  'infrastructure',
  'internal',
])

export type CodeDenErrorCategory = z.infer<typeof CodeDenErrorCategorySchema>

export const CodeDenErrorDataSchema = z.object({
  code: z.string().min(1),
  category: CodeDenErrorCategorySchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.unknown().optional(),
})

export type CodeDenErrorData = z.infer<typeof CodeDenErrorDataSchema>

export class CodeDenError extends Error {
  readonly code: string
  readonly category: CodeDenErrorCategory
  readonly retryable: boolean
  readonly details?: unknown

  constructor(data: CodeDenErrorData) {
    super(data.message)
    this.name = 'CodeDenError'
    this.code = data.code
    this.category = data.category
    this.retryable = data.retryable
    this.details = data.details
  }

  toData(): CodeDenErrorData {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }

  static isCodeDenError(error: unknown): error is CodeDenError {
    return error instanceof CodeDenError
  }
}

export interface IssuePath {
  path: string
  message: string
}

export function parseWithSchema<T>(
  schema: ZodType<T>,
  input: unknown,
  message = 'Invalid input',
): T {
  const result = schema.safeParse(input)
  if (result.success) {
    return result.data
  }

  const issues: IssuePath[] = result.error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
    message: issue.message,
  }))

  throw new CodeDenError({
    code: ErrorCodes.INVALID_INPUT,
    category: 'validation',
    message,
    retryable: false,
    details: { issues },
  })
}

export function getIssuePaths(error: unknown): IssuePath[] {
  if (!CodeDenError.isCodeDenError(error)) {
    return []
  }
  const details = error.details
  if (!details || typeof details !== 'object' || !('issues' in details)) {
    return []
  }
  const issues = (details as { issues?: unknown }).issues
  if (!Array.isArray(issues)) {
    return []
  }
  return issues.filter((issue): issue is IssuePath => {
    return (
      typeof issue === 'object' &&
      issue !== null &&
      'path' in issue &&
      'message' in issue &&
      typeof issue.path === 'string' &&
      typeof issue.message === 'string'
    )
  })
}
