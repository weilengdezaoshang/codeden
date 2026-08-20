import { CodeDenConfigSchema, type CodeDenConfig } from './config-schema.js'
import { configSchemaInvalid, literalSecretForbidden } from './config-errors.js'

const LITERAL_MARKERS = [
  /from:\s*literal/i,
  /apiKey:\s*['"]?sk-/i,
  /apiKey:\s*['"]?xai-/i,
  /value:\s*['"]?(?:sk-|xai-)/i,
]

export function assertNoLiteralSecrets(raw: string): void {
  if (LITERAL_MARKERS.some((marker) => marker.test(raw))) {
    throw literalSecretForbidden()
  }
}

export function parseCodeDenConfig(input: unknown): CodeDenConfig {
  const result = CodeDenConfigSchema.safeParse(input)
  if (result.success) {
    return result.data
  }
  const issues = result.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  throw configSchemaInvalid(`配置 Schema 无效: ${issues}`)
}
