import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { CodeDenConfig, ProviderConfig } from '@codeden/core/config/config-schema.js'
import type { ModelProvider } from './model-provider.js'
import { ModelProviderFactory } from './model-provider-factory.js'

export class ProviderRegistry {
  constructor(private readonly factory: ModelProviderFactory) {}

  createFromConfig(
    config: CodeDenConfig,
    providerName = config.agent.defaultProvider,
    model = config.agent.defaultModel,
  ): ModelProvider {
    const providerConfig = config.providers[providerName]
    if (!providerConfig) {
      throw new CodeDenError({
        code: ErrorCodes.CONFIG_PROVIDER_NOT_FOUND,
        category: 'validation',
        message: `Provider ${providerName} 未在配置中声明`,
        retryable: false,
      })
    }
    return this.create(providerName, providerConfig, model)
  }

  create(name: string, config: ProviderConfig, model?: string): ModelProvider {
    return this.factory.create(name, config, model)
  }
}
