import { createModelProvider } from '@codeden/agent-runtime/models/create-model-provider.js'
import { finalText, toolCall } from '@codeden/agent-runtime/models/mock-model-provider.js'

/** 仅用于内置版本修改 fixture，不代表真实模型评测结果。 */
export function createEvalMockProvider() {
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
