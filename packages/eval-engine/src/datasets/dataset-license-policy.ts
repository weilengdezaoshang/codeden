import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'

const UNDECLARED_LICENSES = new Set(['', 'unknown', 'unlicensed', 'noassertion', 'none'])

export function assertDeclaredDatasetLicense(license: string): void {
  if (UNDECLARED_LICENSES.has(license.trim().toLowerCase())) {
    throw new CodeDenError({
      code: ErrorCodes.INVALID_INPUT,
      category: 'validation',
      message: 'Dataset license must be explicitly declared',
      retryable: false,
      details: { license },
    })
  }
}
