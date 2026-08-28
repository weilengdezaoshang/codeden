import { describe, expect, it } from 'vitest'
import { statusForEvent } from '../../src/cli/terminal-ui-event-sink.js'

describe('测试套件：statusForEvent', () => {
  it.each([
    ['verification.started', 'Verifying'],
    ['tool.called', 'Using tools'],
    ['tool.failed', 'Failed'],
    ['model.completed', 'Completed'],
    ['agent.started', 'Running'],
    ['unknown.event', 'Working'],
  ])('验证：%s -> %s', (type, expected) => {
    expect(statusForEvent(type)).toBe(expected)
  })
})
