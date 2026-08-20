import { z } from 'zod'
import { SecretReferenceSchema } from '../security/secret-reference.js'

export const ProviderConfigSchema = z.object({
  type: z.literal('openai-compatible'),
  baseURL: z.string().url(),
  apiKey: SecretReferenceSchema,
  defaultModel: z.string().min(1),
  capabilities: z.object({
    tools: z.boolean().default(true),
  }),
})

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

export const CodeDenConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    agent: z.object({
      defaultProvider: z.string().min(1),
      defaultModel: z.string().min(1).optional(),
      maxTurns: z.number().int().positive().default(8),
      maxToolCalls: z.number().int().positive().default(16),
    }),
    providers: z.record(z.string().min(1), ProviderConfigSchema),
  })
  .superRefine((config, context) => {
    if (!(config.agent.defaultProvider in config.providers)) {
      context.addIssue({
        code: 'custom',
        path: ['agent', 'defaultProvider'],
        message: '默认 Provider 不存在',
      })
    }
  })

export type CodeDenConfig = z.infer<typeof CodeDenConfigSchema>
