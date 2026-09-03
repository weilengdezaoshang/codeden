import type { ProviderConfig } from '@codeden/core/config/config-schema.js'

export const BUILTIN_PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  anthropic: {
    type: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    apiKey: { from: 'env', name: 'ANTHROPIC_API_KEY' },
    defaultModel: 'claude-sonnet-4-20250514',
    capabilities: { tools: true },
  },
  openai: {
    type: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKey: { from: 'env', name: 'OPENAI_API_KEY' },
    defaultModel: 'gpt-4.1-mini',
    capabilities: { tools: true },
  },
  deepseek: {
    type: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    apiKey: { from: 'env', name: 'DEEPSEEK_API_KEY' },
    defaultModel: 'deepseek-chat',
    capabilities: { tools: true },
  },
  grok: {
    type: 'openai-compatible',
    baseURL: 'https://api.x.ai/v1',
    apiKey: { from: 'env', name: 'XAI_API_KEY' },
    defaultModel: 'grok-4.6',
    capabilities: { tools: true },
  },
}
