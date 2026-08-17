import type { Clock } from '../../core/clock.js'
import { SystemClock } from '../../core/clock.js'
import type { EventSink } from '../../core/events/event-sink.js'
import { RunEventSchema, type RunEventSource } from '../../core/events/run-event.js'
import type { EvalRepository } from '../ports/eval-repository.port.js'

export class EventRecorder implements EventSink {
  private sequence = 0

  constructor(
    private readonly repository: EvalRepository,
    private readonly runId: string,
    private readonly trialId: string,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async emit(source: RunEventSource, type: string, data: unknown = {}): Promise<void> {
    const event = RunEventSchema.parse({
      schemaVersion: 1,
      runId: this.runId,
      trialId: this.trialId,
      sequence: this.sequence++,
      timestamp: this.clock.now().toISOString(),
      source,
      type,
      data,
    })
    await this.repository.appendEvent(event)
  }
}
