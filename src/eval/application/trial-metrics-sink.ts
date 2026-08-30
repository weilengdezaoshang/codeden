import type { EventSink } from '../../core/events/event-sink.js'
import type { RunEventSource } from '../../core/events/run-event.js'
import { ModelUsageSchema } from '../../runtime/models/model-types.js'
import { emptyMetrics, type TrialMetrics } from '../domain/metrics.js'

/** Agent 未返回结果时保留已观察到的消耗；关闭后拒绝迟到事件。 */
export class TrialMetricsSink implements EventSink {
  private closed = false
  private readonly metrics = emptyMetrics()
  private measured = 0
  private readonly requested = new Set<string>()
  private readonly completed = new Set<string>()

  constructor(private readonly inner: EventSink) {}

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    if (this.closed) {
      return
    }
    const value = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const key =
      typeof value.turn === 'number'
        ? JSON.stringify([value.agentSpanId ?? 'root', value.turn])
        : undefined
    if (type === 'model.requested' && (!key || !this.requested.has(key))) {
      if (key) {
        this.requested.add(key)
      }
      this.metrics.modelRequests++
    }
    if (type === 'model.completed' && (!key || !this.completed.has(key))) {
      if (key) {
        this.completed.add(key)
      }
      const usage = ModelUsageSchema.safeParse(value.usage)
      if (usage.success) {
        this.metrics.inputTokens += usage.data.inputTokens
        this.metrics.outputTokens += usage.data.outputTokens
        if (usage.data.status !== 'unavailable') {
          this.measured++
        }
      }
    }
    if (type === 'tool.started') {
      this.metrics.toolCalls++
    }
    if (type === 'tool.failed') {
      this.metrics.toolFailures++
    }
    await this.inner.emit(source, type, data)
  }

  close(): void {
    this.closed = true
  }

  snapshot(): TrialMetrics {
    const totalRequests = Math.max(this.metrics.modelRequests, this.completed.size, this.measured)
    return {
      ...this.metrics,
      modelRequests: totalRequests,
      tokenUsage: {
        status: this.measured ? 'partial' : 'unavailable',
        measuredRequests: this.measured,
        totalRequests,
        collectionComplete: false,
      },
    }
  }
}
