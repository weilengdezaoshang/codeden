import type { ProviderConfig } from '@codeden/core/config/config-schema.js'
import type { ModelProfile } from './model-types.js'

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

/**
 * 内置模型的上下文档案。未登记的模型（含 --model-id 传入的自定义值）不在此表，
 * 由 resolveModelProfile 回退为保守默认并标记 estimated。
 */
export const BUILTIN_MODEL_PROFILES: Record<string, ModelProfile> = {
  'claude-sonnet-4-20250514': {
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    supportsPromptCaching: true,
  },
  'gpt-4.1-mini': {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_000,
    supportsPromptCaching: true,
  },
  'deepseek-chat': { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
  'deepseek-reasoner': { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
  'grok-4.6': {
    contextWindowTokens: 256_000,
    maxOutputTokens: 32_000,
    supportsPromptCaching: true,
  },
}

/** 精确匹配优先，其次最长前缀匹配：既兼容模型 ID 带日期后缀，也兼容短别名。 */
export function builtinModelProfile(model: string | undefined): ModelProfile | undefined {
  if (!model) {
    return undefined
  }
  const exact = BUILTIN_MODEL_PROFILES[model]
  if (exact) {
    return exact
  }
  let best: { key: string; profile: ModelProfile } | undefined
  for (const [key, profile] of Object.entries(BUILTIN_MODEL_PROFILES)) {
    const matches = model.startsWith(key) || key.startsWith(model)
    if (matches && (!best || key.length > best.key.length)) {
      best = { key, profile }
    }
  }
  return best?.profile
}
