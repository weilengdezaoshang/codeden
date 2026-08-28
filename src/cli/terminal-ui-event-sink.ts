import type { EventSink } from '../core/events/event-sink.js'
import type { RunEventSource } from '../core/events/run-event.js'
import type { TerminalUi } from './terminal-ui.js'

/** Converts runtime events into concise messages for the interactive terminal. */
export class TerminalUiEventSink implements EventSink {
  constructor(private readonly ui: TerminalUi) {}

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    this.ui.setStatus(statusForEvent(type))
    if (type === 'model.text_delta' && isTextDelta(data)) {
      this.ui.appendAssistantDelta(data.delta)
      return
    }
    if (type === 'model.completed') {
      this.ui.finishAssistantStream()
    }
    const detail = summarize(data)
    this.ui.addMessage({
      role: source === 'tool' ? 'tool' : source === 'model' ? 'assistant' : 'system',
      content: detail ? type + ': ' + detail : type,
    })
  }
}

function isTextDelta(data: unknown): data is { delta: string } {
  return Boolean(
    data && typeof data === 'object' && 'delta' in data && typeof data.delta === 'string',
  )
}

export function statusForEvent(type: string): string {
  if (type.includes('verification')) {
    return type.endsWith('.failed') ? 'Failed' : 'Verifying'
  }
  if (type.includes('tool')) {
    return type.endsWith('.failed') ? 'Failed' : 'Using tools'
  }
  if (type.endsWith('.failed')) {
    return 'Failed'
  }
  if (type.endsWith('.completed')) {
    return 'Completed'
  }
  if (type.endsWith('.started') || type.endsWith('.requested')) {
    return 'Running'
  }
  return 'Working'
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
