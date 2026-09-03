import { describe, expect, it } from 'vitest'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import type { AgentRunContext } from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import { createAgentRunner } from '../../packages/agent-runtime/src/create-codeden-runtime.js'
import type { ModelProvider } from '../../packages/agent-runtime/src/models/model-provider.js'
import type {
  ModelRequest,
  ModelResponse,
} from '../../packages/agent-runtime/src/models/model-types.js'

const context = (onTextDelta: AgentRunContext['onTextDelta']): AgentRunContext => ({
  runId: 'stream-run',
  trialId: 'stream-trial',
  workspace: {
    root: process.cwd(),
    async changedPaths() {
      return []
    },
  },
  eventSink: new NoopEventSink(),
  limits: { maxTurns: 2, maxToolCalls: 2 },
  submissionType: 'files',
  onTextDelta,
})

describe('测试套件：模型流式输出', () => {
  it('验证：增量文本传递给运行上下文并保留最终响应', async () => {
    const deltas: string[] = []
    const response: ModelResponse = {
      text: '流式完成',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2 },
    }
    const provider: ModelProvider = {
      name: 'stream-test',
      async complete(_request: ModelRequest) {
        return response
      },
      async stream(_request, onTextDelta) {
        await onTextDelta('流式')
        await onTextDelta('完成')
        return response
      },
    }
    const result = await createAgentRunner(provider).run(
      { prompt: '测试', taskSpec: parseTaskSpec({ id: 'stream', goal: '测试' }) },
      context((delta) => {
        deltas.push(delta)
      }),
    )
    expect(deltas).toEqual(['流式', '完成'])
    expect(result.finalResponse).toBe('流式完成')
  })
})
