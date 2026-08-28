import { describe, expect, it } from 'vitest'
import { statusForEvent, summarizeEvent } from '../../src/cli/terminal-ui-event-sink.js'

describe('测试套件：statusForEvent', () => {
  it.each([
    ['verification.started', 'Verifying'],
    ['tool.called', 'Using tools'],
    ['tool.failed', 'Failed'],
    ['model.completed', 'Completed'],
    ['agent.started', 'Running'],
    ['unknown.event', 'Working'],
    ['model.requested', 'Thinking'],
  ])('验证：%s -> %s', (type, expected) => {
    expect(statusForEvent(type)).toBe(expected)
  })

  it('验证：工具事件只显示摘要而不输出原始参数', () => {
    expect(
      summarizeEvent('tool.started', { toolName: 'read_file', arguments: { path: 'a.ts' } }),
    ).toBe('▶ read_file')
    expect(summarizeEvent('tool.completed', { toolName: 'read_file', durationMs: 12.4 })).toBe(
      '✓ read_file (12ms)',
    )
    expect(
      summarizeEvent('tool.failed', { toolName: 'write_file', error: { message: 'denied' } }),
    ).toBe('✗ write_file: denied')
  })

  it('验证：模型生命周期和内部指令事件不重复占用消息区', () => {
    expect(summarizeEvent('model.completed', { turn: 1 })).toBe('')
    expect(summarizeEvent('agent.instructions_loaded', { files: ['SOUL.md'] })).toBe('')
  })
})
