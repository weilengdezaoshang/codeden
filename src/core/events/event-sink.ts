import type { RunEventSource } from './run-event.js'

export interface EventSink {
  emit(source: RunEventSource, type: string, data?: unknown): Promise<void>
}

export class NoopEventSink implements EventSink {
  async emit(_source: RunEventSource, _type: string, _data?: unknown): Promise<void> {}
}
