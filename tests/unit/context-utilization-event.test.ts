import { describe, expect, it } from 'vitest'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import type { EventSink } from '../../packages/core/src/events/event-sink.js'
import type { RunEventSource } from '../../packages/core/src/events/run-event.js'
import type { AgentRunContext } from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import type { ModelProvider } from '../../packages/agent-runtime/src/models/model-provider.js'
import type { ModelRequest } from '../../packages/agent-runtime/src/models/model-types.js'
import { createAgentRunner } from '../../packages/agent-runtime/src/create-codeden-runtime.js'

interface RecordedEvent {
  source: RunEventSource
  type: string
  data?: unknown
}

class CapturingEventSink implements EventSink {
  readonly events: RecordedEvent[] = []

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    this.events.push({ source, type, data })
  }
}

const task = {
  prompt: 'do it',
  taskSpec: parseTaskSpec({ id: 't', goal: 'g' }),
}

describe('测试套件：context.utilization 观测事件', () => {
  it('验证：每次模型请求前按模型档案发上下文占用事件', async () => {
    const requests: ModelRequest[] = []
    // descriptor 命中内置档案表：claude-sonnet-4 → 200_000 tokens 窗口
    const provider: ModelProvider = {
      name: 'profiled-model',
      descriptor: { model: 'claude-sonnet-4-20250514', protocol: 'test' },
      async complete(input) {
        requests.push(input)
        return {
          text: 'done',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const eventSink = new CapturingEventSink()
    const context: AgentRunContext = {
      runId: 'run',
      trialId: 'trial',
      workspace: {
        root: process.cwd(),
        async changedPaths() {
          return []
        },
      },
      eventSink,
      limits: { maxTurns: 5, maxToolCalls: 5 },
      submissionType: 'text',
      readOnly: true,
    }
    const result = await createAgentRunner(provider).run(task, context)

    expect(result.status).toBe('submitted')
    const utilizationEvents = eventSink.events.filter(
      (event) => event.source === 'context' && event.type === 'context.utilization',
    )
    expect(utilizationEvents).toHaveLength(requests.length)
    const firstEvent = utilizationEvents[0]
    if (!firstEvent) {
      throw new Error('expected at least one context.utilization event')
    }
    const first = firstEvent.data as Record<string, unknown>
    expect(first.contextWindowTokens).toBe(200_000)
    expect(first.threshold).toBe(0.7)
    expect(first.estimated).toBe(true)
    expect(first.reserveOutputTokens).toBe(8_192)
    expect(first.turn).toBe(1)
    const estimatedInputTokens = first.estimatedInputTokens as number
    expect(estimatedInputTokens).toBeGreaterThan(0)
    expect(first.ratio).toBeCloseTo((estimatedInputTokens + 8_192) / 200_000)

    // 占用事件先于对应的 model.requested，供 M2 阈值触发接线复用同一信号。
    const requestedIndex = eventSink.events.findIndex((event) => event.type === 'model.requested')
    const utilizationIndex = eventSink.events.findIndex(
      (event) => event.type === 'context.utilization',
    )
    expect(utilizationIndex).toBeLessThan(requestedIndex)
  })

  it('验证：未登记模型按保守默认窗口估算并标记 estimated', async () => {
    const provider: ModelProvider = {
      name: 'unregistered-model',
      descriptor: { model: 'totally-unknown-model', protocol: 'test' },
      async complete() {
        return {
          text: 'done',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const eventSink = new CapturingEventSink()
    await createAgentRunner(provider).run(task, {
      runId: 'run',
      trialId: 'trial',
      workspace: {
        root: process.cwd(),
        async changedPaths() {
          return []
        },
      },
      eventSink,
      limits: { maxTurns: 5, maxToolCalls: 5 },
      submissionType: 'text',
      readOnly: true,
    })
    const event = eventSink.events.find((item) => item.type === 'context.utilization')
    expect(event).toBeDefined()
    const data = event?.data as Record<string, unknown>
    expect(data.contextWindowTokens).toBe(32_000)
    expect(data.estimated).toBe(true)
  })
})
