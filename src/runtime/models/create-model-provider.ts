import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import { createSecurityServices } from '../../security/security-services.js'
import { BUILTIN_PROVIDER_CONFIGS } from './builtin-providers.js'
import {
  MockModelProvider,
  finalText,
  toolCall,
  type MockModelStep,
} from './mock-model-provider.js'
import { ModelProviderFactory } from './model-provider-factory.js'
import type { ModelProvider } from './model-provider.js'

export const MODEL_ALIASES = ['mock', 'openai', 'anthropic', 'deepseek', 'grok'] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function createModelProvider(
  alias: string,
  options: {
    mockSteps?: MockModelStep[]
    security?: ReturnType<typeof createSecurityServices>
  } = {},
): ModelProvider {
  if (alias === 'mock') {
    return new MockModelProvider(
      options.mockSteps ?? [finalText('已收到任务，但当前使用 mock 模型。')],
    )
  }

  const config = BUILTIN_PROVIDER_CONFIGS[alias]
  if (!config) {
    throw new CodeDenError({
      code: ErrorCodes.INVALID_INPUT,
      category: 'validation',
      message: `未知模型: ${alias}。可选: ${MODEL_ALIASES.join(', ')}`,
      retryable: false,
    })
  }

  const security = options.security ?? createSecurityServices()
  return new ModelProviderFactory(security.resolver).create(alias, config)
}

export function createEvalMockProvider(): ModelProvider {
  return createModelProvider('mock', {
    mockSteps: [
      toolCall('read_file', { path: 'package.json' }),
      toolCall('edit_file', {
        path: 'package.json',
        oldText: '"version": "1.0.0"',
        newText: '"version": "2.0.0"',
      }),
      finalText('已完成版本修改'),
    ],
  })
}
