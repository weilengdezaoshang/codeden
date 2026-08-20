import { SecretLeakGuard } from './secret-leak-guard.js'
import { SecretRedactor } from './secret-redactor.js'
import { InMemorySecretRegistry, type SecretRegistry } from './secret-registry.js'
import { EnvSecretResolver, type SecretResolver } from './secret-resolver.js'
import { SensitivePathPolicy } from './sensitive-path-policy.js'

export interface SecurityServices {
  registry: SecretRegistry
  resolver: SecretResolver
  redactor: SecretRedactor
  guard: SecretLeakGuard
  paths: SensitivePathPolicy
}

export function createSecurityServices(
  env: NodeJS.ProcessEnv = process.env,
  registry: SecretRegistry = new InMemorySecretRegistry(),
): SecurityServices {
  const redactor = new SecretRedactor(registry)
  return {
    registry,
    resolver: new EnvSecretResolver(registry, env),
    redactor,
    guard: new SecretLeakGuard(registry, redactor),
    paths: new SensitivePathPolicy(),
  }
}
