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

const McpServerConfigSchema = z
  .object({
    transport: z.enum(['stdio', 'sse']).default('stdio'),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z
      .record(z.string().min(1), z.union([z.string().min(1), SecretReferenceSchema]))
      .default({}),
    url: z.string().url().optional(),
    headers: z
      .record(z.string().min(1), z.union([z.string().min(1), SecretReferenceSchema]))
      .default({}),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(120_000).default(15_000),
  })
  .superRefine((config, context) => {
    if (config.transport === 'stdio' && !config.command) {
      context.addIssue({ code: 'custom', path: ['command'], message: 'stdio MCP 必须配置 command' })
    }
    if (config.transport === 'sse') {
      if (!config.url) {
        context.addIssue({ code: 'custom', path: ['url'], message: 'SSE MCP 必须配置 url' })
      } else if (!/^https?:\/\//u.test(config.url)) {
        context.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'SSE MCP URL 必须使用 HTTP 或 HTTPS',
        })
      }
    }
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
  /** 稳定前缀提示缓存（cache_control）；默认开启，仅对档案声明支持缓存的模型生效。 */
  promptCaching: z.boolean().optional(),
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
      turnTimeoutMs: z.number().int().positive().optional(),
      /**
       * 结构化折叠开关（M2b）：缺省关闭，会话走原有压缩路径；
       * 开启后 submit 前按窗口占用/熔断信号触发折叠。供回滚与 A/B 对照。
       */
      folding: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
      /**
       * 子 Agent 结果回传模式（M3/EX-14）：summary（默认）只把结构化摘要
       * 注入父上下文；full 保留完整子任务结果（回滚开关）。
       */
      subagent: z
        .object({ summaryMode: z.enum(['full', 'summary']).default('summary') })
        .default({ summaryMode: 'summary' }),
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
    telemetry: z
      .object({
        enabled: z.boolean().default(false),
        consentId: z.string().min(1).optional(),
        traceRetentionDays: z.number().int().positive().max(365).default(30),
        maxTraceFiles: z.number().int().positive().max(10_000).default(500),
      })
      .default({ enabled: false, traceRetentionDays: 30, maxTraceFiles: 500 }),
  })
  .superRefine((config, context) => {
    if (!(config.agent.defaultProvider in config.providers)) {
      context.addIssue({
        code: 'custom',
        path: ['agent', 'defaultProvider'],
        message: '默认 Provider 不存在',
      })
    }
    if (config.telemetry.enabled && !config.telemetry.consentId) {
      context.addIssue({
        code: 'custom',
        path: ['telemetry', 'consentId'],
        message: '启用 Trace 上传队列前必须提供 consentId',
      })
    }
  })

export type CodeDenConfig = z.infer<typeof CodeDenConfigSchema>
