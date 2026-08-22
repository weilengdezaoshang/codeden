import { z } from 'zod'
import { SecretReferenceSchema } from '../security/secret-reference.js'

export const DEFAULT_DOCS_DOMAINS = [
  'nodejs.org',
  'typescriptlang.org',
  'www.typescriptlang.org',
  'react.dev',
  'developer.mozilla.org',
  'docs.npmjs.com',
  'pnpm.io',
  'docs.github.com',
] as const

const DocsNetworkConfigSchema = z.object({
  enabled: z.boolean().default(true),
  allowedDomains: z
    .array(z.string().regex(/^[A-Za-z0-9.-]+$/u))
    .min(1)
    .default([...DEFAULT_DOCS_DOMAINS]),
})

const CommandNetworkConfigSchema = z.object({
  mode: z.enum(['host', 'docker']).default('host'),
  image: z.string().min(1).default('node:24-bookworm-slim'),
  dockerContext: z.string().min(1).optional(),
  dockerHost: z.string().min(1).optional(),
})

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
    network: z
      .object({
        docs: DocsNetworkConfigSchema.default({
          enabled: true,
          allowedDomains: [...DEFAULT_DOCS_DOMAINS],
        }),
        commands: CommandNetworkConfigSchema.default({
          mode: 'host',
          image: 'node:24-bookworm-slim',
        }),
      })
      .default({
        docs: { enabled: true, allowedDomains: [...DEFAULT_DOCS_DOMAINS] },
        commands: { mode: 'host', image: 'node:24-bookworm-slim' },
      }),
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
