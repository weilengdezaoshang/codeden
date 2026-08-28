import { describe, expect, it, vi } from 'vitest'
import {
  formatDiffForDisplay,
  TerminalUi,
  maxTerminalScroll,
  wrapTerminalText,
} from '../../src/cli/terminal-ui.js'

describe('测试套件：terminal layout helpers', () => {
  it('验证：clamps scroll to the actual viewport', () => {
    expect(maxTerminalScroll(10, 4)).toBe(6)
    expect(maxTerminalScroll(2, 4)).toBe(0)
    expect(maxTerminalScroll(10, 0)).toBe(9)
  })

  it('验证：wraps text without splitting surrogate pairs', () => {
    expect(wrapTerminalText('abcdef', 3)).toEqual(['abc', 'def'])
    expect(wrapTerminalText('😀😀', 1)).toEqual(['😀', '😀'])
    expect(wrapTerminalText('', 3)).toEqual([''])
  })

  it('验证：超长 diff 显示截断提示', () => {
    const diff = 'x'.repeat(500_001)
    const rendered = formatDiffForDisplay(diff)
    expect(rendered).toContain('diff truncated after 500000 characters')
    expect(rendered.length).toBe(500_000 + 1 + 42)
  })

  it('验证：提交任务期间 Ctrl-C 请求取消而不是直接退出', async () => {
    const onCancel = vi.fn()
    const ui = new TerminalUi({ onSubmit: async () => undefined, onCancel })
    const internals = ui as unknown as {
      submitting: boolean
      onKeypress: (value: string, key: unknown) => Promise<void> | void
    }
    internals.submitting = true

    await internals.onKeypress('', { name: 'c', ctrl: true })

    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('验证：提交任务期间 Escape 同样请求取消', async () => {
    const onCancel = vi.fn()
    const ui = new TerminalUi({ onSubmit: async () => undefined, onCancel })
    const internals = ui as unknown as {
      submitting: boolean
      onKeypress: (value: string, key: unknown) => Promise<void> | void
    }
    internals.submitting = true

    await internals.onKeypress('', { name: 'escape' })

    expect(onCancel).toHaveBeenCalledOnce()
  })
})
