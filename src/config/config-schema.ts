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

const CommandNetworkConfigSchema = z
  .object({
    mode: z.enum(['host', 'docker']).default('host'),
    image: z.string().min(1).default('node:24-bookworm-slim'),
    readOnly: z.boolean().default(false),
    dockerContext: z.string().min(1).optional(),
    dockerHost: z
      .string()
      .regex(/^(unix|tcp|ssh):\/\/.+/u, 'Docker host 必须使用 unix://、tcp:// 或 ssh:// 地址')
      .optional(),
    cpus: z.number().positive().max(64).optional(),
    memoryLimit: z
      .string()
      .regex(/^\d+(?:[bBkKmMgGtTpP]i?)?$/u, 'memoryLimit 必须是带单位的内存大小')
      .optional(),
    tmpfsSize: z
      .string()
      .regex(/^\d+(?:[kKmMgG])?$/u, 'tmpfsSize 必须是有效的临时磁盘大小')
      .optional(),
    pidsLimit: z.number().int().positive().max(32_768).default(256),
  })
  .superRefine((config, context) => {
    if (config.dockerContext && config.dockerHost) {
      context.addIssue({
        code: 'custom',
        path: ['dockerHost'],
        message: 'dockerContext 与 dockerHost 不能同时配置',
      })
    }
  })

const McpServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string().min(1), z.union([z.string().min(1), SecretReferenceSchema])).default({}),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(120_000).default(15_000),
})

const OpenAIProviderConfigSchema = z.object({
  type: z.literal('openai-compatible'),
  baseURL: z.string().url(),
  apiKey: SecretReferenceSchema,
  defaultModel: z.string().min(1),
  capabilities: z.object({
    tools: z.boolean().default(true),
  }),
})

const AnthropicProviderConfigSchema = z.object({
  type: z.literal('anthropic'),
  baseURL: z.string().url().default('https://api.anthropic.com'),
  apiKey: SecretReferenceSchema,
  defaultModel: z.string().min(1),
  capabilities: z.object({ tools: z.boolean().default(true) }),
})

export const ProviderConfigSchema = z.discriminatedUnion('type', [
  OpenAIProviderConfigSchema,
  AnthropicProviderConfigSchema,
])

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
          readOnly: false,
          pidsLimit: 256,
        }),
      })
      .default({
        docs: { enabled: true, allowedDomains: [...DEFAULT_DOCS_DOMAINS] },
        commands: { mode: 'host', image: 'node:24-bookworm-slim', readOnly: false, pidsLimit: 256 },
      }),
    mcp: z
      .object({ servers: z.record(z.string().min(1), McpServerConfigSchema).default({}) })
      .default({ servers: {} }),
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
