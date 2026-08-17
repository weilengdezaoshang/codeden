import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import {
  MockModelProvider,
  finalText,
  toolCall,
  type MockModelStep,
} from './mock-model-provider.js'
import type { ModelProvider } from './model-provider.js'
import { OpenAIModelProvider } from './openai-model-provider.js'

export const MODEL_ALIASES = ['mock', 'openai', 'deepseek', 'grok'] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function createModelProvider(
  alias: string,
  options: { mockSteps?: MockModelStep[] } = {},
): ModelProvider {
  switch (alias) {
    case 'mock':
      return new MockModelProvider(
        options.mockSteps ?? [finalText('已收到任务，但当前使用 mock 模型。')],
      )
    case 'openai':
      return new OpenAIModelProvider({
        name: 'openai',
        model: process.env.CODEDEN_OPENAI_MODEL ?? 'gpt-4.1-mini',
        apiKey: requireKey('OPENAI_API_KEY', 'openai'),
      })
    case 'deepseek':
      return new OpenAIModelProvider({
        name: 'deepseek',
        model: process.env.CODEDEN_DEEPSEEK_MODEL ?? 'deepseek-chat',
        apiKey: requireKey('DEEPSEEK_API_KEY', 'deepseek'),
        baseURL: process.env.CODEDEN_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      })
    case 'grok':
      return new OpenAIModelProvider({
        name: 'grok',
        model: process.env.CODEDEN_GROK_MODEL ?? 'grok-4.6',
        apiKey: requireKey('XAI_API_KEY', 'grok'),
        baseURL: process.env.CODEDEN_GROK_BASE_URL ?? 'https://api.x.ai/v1',
      })
    default:
      throw new CodeDenError({
        code: ErrorCodes.INVALID_INPUT,
        category: 'validation',
        message: `未知模型: ${alias}。可选: ${MODEL_ALIASES.join(', ')}`,
        retryable: false,
      })
  }
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

function requireKey(envName: string, alias: string): string {
  const value = process.env[envName]?.trim()
  if (value) {
    return value
  }
  throw new CodeDenError({
    code: ErrorCodes.INVALID_INPUT,
    category: 'validation',
    message: `使用 --model ${alias} 时必须设置环境变量 ${envName}`,
    retryable: false,
  })
}
