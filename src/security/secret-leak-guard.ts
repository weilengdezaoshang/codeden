import { CodeDenError } from '../core/errors/codeden-error.js'
import { ErrorCodes } from '../core/errors/error-codes.js'
import { safeStringify } from './safe-serialization.js'
import type { SecretRedactor } from './secret-redactor.js'
import type { SecretRegistry } from './secret-registry.js'

const OBVIOUS_SECRET = /(?:sk|xai)-[A-Za-z0-9]{8,}/

export class SecretLeakGuard {
  constructor(
    private readonly registry: SecretRegistry,
    private readonly redactor: SecretRedactor,
  ) {}

  assertSafe(value: unknown, destination: string): void {
    const text = typeof value === 'string' ? value : safeStringify(value)
    if (this.registry.containsSecret(text) || OBVIOUS_SECRET.test(text)) {
      throw new CodeDenError({
        code: ErrorCodes.SECRET_LEAK_DETECTED,
        category: 'permission',
        message: `Secret leak blocked for ${destination}`,
        retryable: false,
        details: { destination },
      })
    }
    const redacted = this.redactor.redact(text)
    if (this.registry.containsSecret(redacted)) {
      throw new CodeDenError({
        code: ErrorCodes.SECRET_LEAK_DETECTED,
        category: 'permission',
        message: `Secret leak blocked for ${destination}`,
        retryable: false,
        details: { destination },
      })
    }
  }
}
