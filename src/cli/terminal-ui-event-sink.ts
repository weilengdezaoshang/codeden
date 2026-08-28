import type { EventSink } from '../core/events/event-sink.js'
import type { RunEventSource } from '../core/events/run-event.js'
import type { TerminalUi } from './terminal-ui.js'

/** Converts runtime events into concise messages for the interactive terminal. */
export class TerminalUiEventSink implements EventSink {
  constructor(private readonly ui: TerminalUi) {}

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    this.ui.setStatus(statusForEvent(type, data))
    if (type === 'model.text_delta' && isTextDelta(data)) {
      this.ui.appendAssistantDelta(data.delta)
      return
    }
    if (type === 'model.completed') {
      this.ui.finishAssistantStream()
    }
    const detail = summarizeEvent(type, data)
    if (!detail) {
      return
    }
    this.ui.addMessage({
      role: source === 'tool' ? 'tool' : source === 'model' ? 'assistant' : 'system',
      content: detail,
    })
  }
}

function isTextDelta(data: unknown): data is { delta: string } {
  return Boolean(
    data && typeof data === 'object' && 'delta' in data && typeof data.delta === 'string',
  )
}

export function statusForEvent(type: string, data?: unknown): string {
  if (type === 'model.requested') {
    return 'Thinking'
  }
  if (type === 'tool.started' && isToolEvent(data)) {
    return `Using ${data.toolName}`
  }
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

export function summarizeEvent(type: string, data?: unknown): string {
  if (type === 'model.text_delta' || type === 'model.requested' || type === 'model.completed') {
    return ''
  }
  if (
    type === 'agent.started' ||
    type === 'agent.instructions_loaded' ||
    type === 'agent.completion_proposed' ||
    type === 'agent.submitted'
  ) {
    return ''
  }
  if (type === 'tool.started' && isToolEvent(data)) {
    return `▶ ${data.toolName}`
  }
  if (type === 'tool.completed' && isToolEvent(data)) {
    return `✓ ${data.toolName}${typeof data.durationMs === 'number' ? ` (${Math.round(data.durationMs)}ms)` : ''}`
  }
  if (type === 'tool.failed' && isToolEvent(data)) {
    return `✗ ${data.toolName}: ${errorMessage(data.error)}`
  }
  if (type === 'verification.started') {
    return 'Verification started'
  }
  if (type === 'verification.completed') {
    return isVerificationEvent(data) && data.status === 'passed'
      ? '✓ Verification passed'
      : 'Verification completed'
  }
  if (type === 'verification.failed') {
    return `✗ Verification failed${isVerificationEvent(data) && data.message ? `: ${data.message}` : ''}`
  }
  return type
}

function isToolEvent(
  data: unknown,
): data is { toolName: string; durationMs?: number; error?: unknown } {
  return Boolean(
    data && typeof data === 'object' && 'toolName' in data && typeof data.toolName === 'string',
  )
}

function isVerificationEvent(data: unknown): data is { status?: string; message?: string } {
  return Boolean(data && typeof data === 'object')
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return 'tool execution failed'
}
