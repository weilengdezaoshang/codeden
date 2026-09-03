import { inspect } from 'node:util'
import { ResolvedSecret } from './resolved-secret.js'

export function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof ResolvedSecret) {
      return '<redacted>'
    }
    if (item instanceof Error) {
      return { name: item.name, message: item.message }
    }
    return item
  })
}

export function safeInspect(value: unknown): string {
  return inspect(value, { customInspect: true, depth: 6 })
}
