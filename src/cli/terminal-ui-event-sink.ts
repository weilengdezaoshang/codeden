import type { EventSink } from '../core/events/event-sink.js'
import type { RunEventSource } from '../core/events/run-event.js'
import type { TerminalUi } from './terminal-ui.js'

/** Converts runtime events into concise messages for the interactive terminal. */
export class TerminalUiEventSink implements EventSink {
  constructor(private readonly ui: TerminalUi) {}

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    const detail = summarize(data)
    this.ui.addMessage({
      role: source === 'tool' ? 'tool' : source === 'model' ? 'assistant' : 'system',
      content: detail ? type + ': ' + detail : type,
    })
  }
}

function summarize(data: unknown): string {
  if (data === undefined) {
    return ''
  }
  if (typeof data === 'string') {
    return data
  }
  try {
    return JSON.stringify(data)
  } catch {
    return '[unserializable event]'
  }
}
