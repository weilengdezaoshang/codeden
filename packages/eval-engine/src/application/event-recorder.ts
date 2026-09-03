import { randomUUID } from 'node:crypto'
import type { Clock } from '@codeden/core/clock.js'
import { SystemClock } from '@codeden/core/clock.js'
import type { EventSink } from '@codeden/core/events/event-sink.js'
import { RunEventSchema, type RunEventSource } from '@codeden/core/events/run-event.js'
import type { EvalRepository } from '../ports/eval-repository.port.js'

export class EventRecorder implements EventSink {
  private sequence = 0
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: EvalRepository,
    private readonly runId: string,
    private readonly trialId: string,
    private readonly clock: Clock = new SystemClock(),
    private readonly route: { jobId?: string; benchmarkRunId?: string } = {},
  ) {}

  async emit(source: RunEventSource, type: string, data: unknown = {}): Promise<void> {
    const operation = this.queue.then(async () => {
      const event = RunEventSchema.parse({
        schemaVersion: 1,
        eventId: randomUUID(),
        ...this.route,
        runId: this.runId,
        trialId: this.trialId,
        sequence: this.sequence++,
        timestamp: this.clock.now().toISOString(),
        source,
        type,
        data,
      })
      await this.repository.appendEvent(event)
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }
}
