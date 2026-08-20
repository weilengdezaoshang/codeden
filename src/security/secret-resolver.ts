import { CodeDenError } from '../core/errors/codeden-error.js'
import { ErrorCodes } from '../core/errors/error-codes.js'
import { ResolvedSecret } from './resolved-secret.js'
import type { SecretReference } from './secret-reference.js'
import type { SecretRegistry } from './secret-registry.js'

export interface SecretResolver {
  resolve(reference: SecretReference): ResolvedSecret
}

export class EnvSecretResolver implements SecretResolver {
  constructor(
    private readonly registry: SecretRegistry,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  resolve(reference: SecretReference): ResolvedSecret {
    if (reference.from !== 'env') {
      throw new CodeDenError({
        code: ErrorCodes.SECRET_LITERAL_FORBIDDEN,
        category: 'validation',
        message: 'Only environment variable secret references are allowed',
        retryable: false,
      })
    }

    const raw = this.env[reference.name]
    if (raw === undefined || raw.trim() === '') {
      throw new CodeDenError({
        code: ErrorCodes.SECRET_ENV_NOT_FOUND,
        category: 'validation',
        message: `环境变量 ${reference.name} 未配置`,
        retryable: false,
      })
    }

    const secret = new ResolvedSecret(raw.trim())
    this.registry.register(secret)
    return secret
  }
}
