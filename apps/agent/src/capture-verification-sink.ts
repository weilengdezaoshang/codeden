import type { EventSink } from '@codeden/core/events/event-sink.js'
import type { RunEventSource } from '@codeden/core/events/run-event.js'
import type { CompletionCheck } from '@codeden/agent-runtime/verification/verification-result.js'

export class CaptureVerificationSink implements EventSink {
  lastCheck: CompletionCheck | undefined

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    void source
    if (
      (type === 'verification.failed' || type === 'verification.completed') &&
      data &&
      typeof data === 'object' &&
      'passed' in data
    ) {
      this.lastCheck = data as CompletionCheck
    }
  }
}
