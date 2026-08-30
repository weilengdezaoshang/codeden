import type { EventSink } from '../core/events/event-sink.js'
import type { RunEventSource } from '../core/events/run-event.js'
import { buildMetadataUploadEnvelope } from './trace-upload-envelope.js'
import type { LocalTraceRecorder } from './local-trace-recorder.js'
import type { TraceOutbox } from './trace-outbox.js'
import { contentDigest } from '../core/content-digest.js'
import { isRootTraceData } from './trace-file-reader.js'

export class TraceCaptureSink implements EventSink {
  private finalized = false
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      recorder: LocalTraceRecorder
      outbox?: TraceOutbox
      consent?: { granted: boolean; consentId?: string }
    },
  ) {}

  async emit(source: RunEventSource, type: string, data: unknown = {}): Promise<void> {
    const operation = this.pending.then(() => this.capture(source, type, data))
    this.pending = operation.catch(() => undefined)
    return operation
  }

  private async capture(source: RunEventSource, type: string, data: unknown): Promise<void> {
    const child = !isRootTraceData(data)
    const terminal = type === 'agent.completed' && !child
    // 授权摘要与终态一起落盘，使 enqueue 失败后仍有持久的补偿依据。
    const recordedData = terminal
      ? {
          ...(data && typeof data === 'object' ? data : {}),
          captureConsentDigest:
            this.options.outbox && this.options.consent?.granted && this.options.consent.consentId
              ? contentDigest(this.options.consent.consentId)
              : undefined,
        }
      : data
    await this.options.recorder.emit(source, type, recordedData)
    if (type !== 'agent.completed' || child || this.finalized) {
      return
    }
    if (!this.options.outbox || !this.options.consent?.granted) {
      return
    }
    const events = await this.options.recorder.readAll()
    await this.options.outbox.enqueue(
      buildMetadataUploadEnvelope(events, {
        granted: true,
        consentId: this.options.consent.consentId,
      }),
    )
    this.finalized = true
  }
}
