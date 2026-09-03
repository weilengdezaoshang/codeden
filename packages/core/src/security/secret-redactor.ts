import { ResolvedSecret } from './resolved-secret.js'
import type { SecretRegistry } from './secret-registry.js'

const PATTERN_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /Authorization:\s*Bearer\s+\S+/gi, replacement: 'Authorization: Bearer <redacted>' },
  { pattern: /Bearer\s+[A-Za-z0-9._\-+=/]+/g, replacement: 'Bearer <redacted>' },
  { pattern: /(api[_-]?key\s*[:=]\s*)\S+/gi, replacement: '$1<redacted>' },
  { pattern: /xai-[A-Za-z0-9]+/g, replacement: '<redacted>' },
  { pattern: /sk-[A-Za-z0-9]+/g, replacement: '<redacted>' },
]

export class SecretRedactor {
  constructor(private readonly registry: SecretRegistry) {}

  redact(text: string): string {
    let output = this.registry.redact(text)
    for (const rule of PATTERN_RULES) {
      output = output.replace(rule.pattern, rule.replacement)
    }
    return output
  }

  redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.redact(value)
    }
    if (value instanceof ResolvedSecret) {
      return '<redacted>'
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item))
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        result[key] = this.redactValue(item)
      }
      return result
    }
    return value
  }
}
