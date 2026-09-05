import { afterEach, describe, expect, it } from 'vitest'
import { createModelProvider } from '../../packages/agent-runtime/src/models/create-model-provider.js'
import { DependencyContainer } from '../../apps/agent/src/dependency-container.js'
import { ModelProviderFactory } from '../../packages/agent-runtime/src/models/model-provider-factory.js'
import { ProviderRegistry } from '../../packages/agent-runtime/src/models/provider-registry.js'
import { createSecurityServices } from '../../packages/core/src/security/security-services.js'
import type { CodeDenConfig } from '../../packages/core/src/config/config-schema.js'

function minimalConfig(providers: CodeDenConfig['providers']): CodeDenConfig {
  return {
    schemaVersion: 1,
    agent: { defaultProvider: 'deepseek', maxTurns: 8, maxToolCalls: 16 },
    providers,
    network: {
      docs: { enabled: true, allowedDomains: ['nodejs.org'] },
      commands: { mode: 'host', image: 'node:24-bookworm-slim', readOnly: false, pidsLimit: 256 },
    },
    mcp: { servers: {} },
    telemetry: { enabled: false, traceRetentionDays: 30, maxTraceFiles: 500 },
  } as unknown as CodeDenConfig
}

const original = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
}

afterEach(() => {
  restore('DEEPSEEK_API_KEY', original.DEEPSEEK_API_KEY)
  restore('OPENAI_API_KEY', original.OPENAI_API_KEY)
  restore('XAI_API_KEY', original.XAI_API_KEY)
})

describe('测试套件：createModelProvider', () => {
  it('验证：creates a mock provider without any API key', () => {
    expect(createModelProvider('mock').name).toBe('mock-model')
  })

  it('验证：requires DEEPSEEK_API_KEY for --model deepseek', () => {
    delete process.env.DEEPSEEK_API_KEY
    expect(() => createModelProvider('deepseek')).toThrow(/DEEPSEEK_API_KEY/)
  })

  it('验证：creates a deepseek provider when the key is set', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    expect(createModelProvider('deepseek').name).toBe('deepseek')
  })

  it('验证：rejects an unknown model alias', () => {
    expect(() => createModelProvider('claude')).toThrow(/未知模型/)
  })

  it('验证：用户配置未声明 Provider 时回退内置目录', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    const registry = new ProviderRegistry(
      new ModelProviderFactory(createSecurityServices().resolver),
    )
    const provider = registry.createFromConfig(minimalConfig({}), 'deepseek')
    expect(provider.name).toBe('deepseek')
    expect(provider.descriptor?.model).toBe('deepseek-chat')
  })

  it('验证：--model deepseek 别名选择 Provider 且 wire model 取 defaultModel', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    const container = new DependencyContainer()
    const config = minimalConfig({
      deepseek: {
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com',
        apiKey: { from: 'env', name: 'DEEPSEEK_API_KEY' },
        defaultModel: 'deepseek-chat',
        capabilities: { tools: true },
      },
    })
    expect(container.createProvider(config, undefined, 'deepseek').descriptor?.model).toBe(
      'deepseek-chat',
    )
    expect(
      container.createProvider(config, 'deepseek', 'deepseek-reasoner').descriptor?.model,
    ).toBe('deepseek-reasoner')
  })
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}
