import type { RunEventSource } from './run-event.js'

export interface EventSink {
  emit(source: RunEventSource, type: string, data?: unknown): Promise<void>
}

export class NoopEventSink implements EventSink {
  async emit(_source: RunEventSource, _type: string, _data?: unknown): Promise<void> {}
}

export class CompositeEventSink implements EventSink {
  constructor(private readonly sinks: readonly EventSink[]) {}

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.emit(source, type, data)))
  }
}

export class BestEffortEventSink implements EventSink {
  constructor(private readonly inner: EventSink) {}

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    await this.inner.emit(source, type, data).catch(() => undefined)
  }
}
