import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import type { ProviderConfig } from '../../config/config-schema.js'
import type { SecretResolver } from '../../security/secret-resolver.js'
import type { ModelProvider } from './model-provider.js'
import { OpenAIModelProvider } from './openai-model-provider.js'

export class ModelProviderFactory {
  constructor(private readonly resolver: SecretResolver) {}

  create(name: string, config: ProviderConfig, model?: string): ModelProvider {
    if (config.type !== 'openai-compatible') {
      throw new CodeDenError({
        code: ErrorCodes.CONFIG_SCHEMA_INVALID,
        category: 'validation',
        message: `Unsupported provider type: ${String(config.type)}`,
        retryable: false,
      })
    }

    const apiKey = this.resolver.resolve(config.apiKey)
    return new OpenAIModelProvider({
      name,
      model: model ?? config.defaultModel,
      baseURL: config.baseURL,
      apiKey,
    })
  }
}
