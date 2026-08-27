import { describe, expect, it } from 'vitest'
import { statusForEvent } from '../../src/cli/terminal-ui-event-sink.js'

describe('statusForEvent', () => {
  it.each([
    ['verification.started', 'Verifying'],
    ['tool.called', 'Using tools'],
    ['tool.failed', 'Failed'],
    ['model.completed', 'Completed'],
    ['agent.started', 'Running'],
    ['unknown.event', 'Working'],
  ])('%s -> %s', (type, expected) => {
    expect(statusForEvent(type)).toBe(expected)
  })
})
