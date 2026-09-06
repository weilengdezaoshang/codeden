import type { ProviderConfig } from '@codeden/core/config/config-schema.js'
import type { SecretResolver } from '@codeden/core/security/secret-resolver.js'
import type { ModelProvider } from './model-provider.js'
import { OpenAIModelProvider } from './openai-model-provider.js'
import { AnthropicModelProvider } from './anthropic-model-provider.js'

export class ModelProviderFactory {
  constructor(private readonly resolver: SecretResolver) {}

  create(name: string, config: ProviderConfig, model?: string): ModelProvider {
    const apiKey = this.resolver.resolve(config.apiKey)
    if (config.type === 'anthropic') {
      return new AnthropicModelProvider({
        name,
        model: model ?? config.defaultModel,
        baseURL: config.baseURL,
        apiKey,
        promptCaching: config.promptCaching,
      })
    }
    return new OpenAIModelProvider({
      name,
      model: model ?? config.defaultModel,
      baseURL: config.baseURL,
      apiKey,
    })
  }
}
