import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { ResolvedSecret } from '../../../src/security/resolved-secret.js'
import { SecretRedactor } from '../../../src/security/secret-redactor.js'
import { InMemorySecretRegistry } from '../../../src/security/secret-registry.js'
import { SecretLeakGuard } from '../../../src/security/secret-leak-guard.js'

const SENTINEL = ['codeden', 'secret', 'must', 'never', 'appear'].join('-')

describe('测试套件：ResolvedSecret', () => {
  it('验证：never prints the raw value', () => {
    const secret = new ResolvedSecret(SENTINEL)
    expect(String(secret)).toBe('<redacted>')
    expect(JSON.stringify(secret)).not.toContain(SENTINEL)
    expect(inspect(secret)).not.toContain(SENTINEL)
    expect(new Error(String(secret)).message).not.toContain(SENTINEL)
  })
})

describe('测试套件：SecretRedactor', () => {
  it('验证：redacts registered secrets before pattern matches', () => {
    const registry = new InMemorySecretRegistry()
    const secret = new ResolvedSecret(SENTINEL)
    registry.register(secret)
    const redactor = new SecretRedactor(registry)
    const fakeKey = ['sk', 'abcdefghi123456789'].join('-')
    expect(redactor.redact(`token ${SENTINEL} ${fakeKey}`)).toBe('token <redacted> <redacted>')
  })

  it('验证：redacts bearer headers', () => {
    const redactor = new SecretRedactor(new InMemorySecretRegistry())
    expect(redactor.redact('Authorization: Bearer abc.def')).toBe(
      'Authorization: Bearer <redacted>',
    )
  })
})

describe('测试套件：SecretLeakGuard', () => {
  it('验证：blocks known secrets without echoing them', () => {
    const registry = new InMemorySecretRegistry()
    registry.register(new ResolvedSecret(SENTINEL))
    const redactor = new SecretRedactor(registry)
    const guard = new SecretLeakGuard(registry, redactor)
    expect(() => guard.assertSafe(`leak ${SENTINEL}`, 'console')).toThrow(/console/)
    try {
      guard.assertSafe(`leak ${SENTINEL}`, 'console')
    } catch (error) {
      expect(String(error)).not.toContain(SENTINEL)
    }
  })
})
