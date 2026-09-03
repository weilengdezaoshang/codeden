import { z } from 'zod'
import { parseWithSchema } from '../errors/codeden-error.js'

export const SecretReferenceSchema = z.object({
  from: z.literal('env'),
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
})

export type SecretReference = z.infer<typeof SecretReferenceSchema>

export function parseSecretReference(input: unknown): SecretReference {
  return parseWithSchema(SecretReferenceSchema, input, 'Invalid SecretReference')
}
