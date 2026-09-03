import type { ToolContext } from './tool.js'
import { SecretLeakGuard } from '@codeden/core/security/secret-leak-guard.js'
import { SecretRedactor } from '@codeden/core/security/secret-redactor.js'
import { InMemorySecretRegistry } from '@codeden/core/security/secret-registry.js'
import { SensitivePathPolicy } from '@codeden/core/security/sensitive-path-policy.js'

const fallbackRegistry = new InMemorySecretRegistry()
const fallbackRedactor = new SecretRedactor(fallbackRegistry)
const fallbackGuard = new SecretLeakGuard(fallbackRegistry, fallbackRedactor)
const fallbackPaths = new SensitivePathPolicy()

export function pathPolicyOf(context: ToolContext): SensitivePathPolicy {
  return context.security?.paths ?? fallbackPaths
}

export function redactorOf(context: ToolContext): SecretRedactor {
  return context.security?.redactor ?? fallbackRedactor
}

export function guardOf(context: ToolContext): SecretLeakGuard {
  return context.security?.guard ?? fallbackGuard
}
