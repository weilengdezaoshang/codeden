import type { EventSink } from '../core/events/event-sink.js'
import type { RunEventSource } from '../core/events/run-event.js'
import type { SecretLeakGuard } from './secret-leak-guard.js'
import type { SecretRedactor } from './secret-redactor.js'

export class SecureEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly redactor: SecretRedactor,
    private readonly guard: SecretLeakGuard,
  ) {}

  async emit(source: RunEventSource, type: string, data: unknown = {}): Promise<void> {
    const safeData = this.redactor.redactValue(data)
    this.guard.assertSafe(safeData, `event:${type}`)
    await this.inner.emit(source, type, safeData)
  }
}
