import { randomUUID } from 'node:crypto'
import type { AgentRunContext } from './agent-contracts.js'
import type { TrialMetrics } from '@codeden/core/metrics.js'
import { ModelUsageSchema } from '../models/model-types.js'

/** 为父子 Agent 事件保留身份，并从子模型事件累计消耗，避免漏记或重复计算子树汇总。 */
export function createAgentEventScope(context: AgentRunContext) {
  const parentSink = context.eventSink
  const scope = { agentSpanId: randomUUID(), agentDepth: context.subagentDepth ?? 0 }
  const child = { requests: 0, measured: 0, input: 0, output: 0 }
  const scoped: AgentRunContext = {
    ...context,
    eventSink: {
      emit(source, type, data = {}) {
        if (
          data &&
          typeof data === 'object' &&
          'agentDepth' in data &&
          typeof data.agentDepth === 'number' &&
          data.agentDepth > scope.agentDepth
        ) {
          if (type === 'model.requested') {
            child.requests++
          }
          if (type === 'model.completed' && 'usage' in data) {
            const usage = ModelUsageSchema.safeParse(data.usage)
            if (usage.success) {
              child.input += usage.data.inputTokens
              child.output += usage.data.outputTokens
              if (usage.data.status !== 'unavailable') {
                child.measured++
              }
            }
          }
        }
        return parentSink.emit(source, type, {
          ...scope,
          ...(data && typeof data === 'object' ? data : { payload: data }),
        })
      },
    },
  }
  return {
    context: scoped,
    aggregate(metrics: TrialMetrics): TrialMetrics {
      const measured = (metrics.tokenUsage?.measuredRequests ?? 0) + child.measured
      const requests = metrics.modelRequests + child.requests
      return {
        ...metrics,
        modelRequests: requests,
        inputTokens: metrics.inputTokens + child.input,
        outputTokens: metrics.outputTokens + child.output,
        tokenUsage: {
          status: measured === 0 ? 'unavailable' : measured === requests ? 'complete' : 'partial',
          measuredRequests: measured,
          totalRequests: requests,
        },
      }
    },
  }
}
