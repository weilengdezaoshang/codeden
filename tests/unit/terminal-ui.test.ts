import { describe, expect, it, vi } from 'vitest'
import {
  formatDiffForDisplay,
  completeCommand,
  codedenBannerLines,
  formatMessageForTerminal,
  rememberInput,
  renderHomeBanner,
  INTERACTIVE_COMMANDS,
  TerminalUi,
  maxTerminalScroll,
  wrapTerminalText,
} from '../../apps/agent/src/terminal-ui.js'

function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '')
}

function visibleLength(line: string): number {
  return Array.from(stripAnsi(line)).length
}

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
    expect(wrapTerminalText('first\nsecond', 20)).toEqual(['first', 'second'])
  })

  it('验证：超长 diff 显示截断提示', () => {
    const diff = 'x'.repeat(500_001)
    const rendered = formatDiffForDisplay(diff)
    expect(rendered).toContain('diff truncated after 500000 characters')
    expect(rendered.length).toBe(500_000 + 1 + 42)
  })

  it('验证：只为斜杠命令提供补全候选', () => {
    expect(completeCommand('/per')).toEqual([['/permission', '/persona'], '/per'])
    expect(completeCommand('读取')).toEqual([[], '读取'])
    expect(completeCommand('/unknown')).toEqual([[], '/unknown'])
    expect(INTERACTIVE_COMMANDS).toContain('/apply')
  })

  it('验证：输入历史去重、忽略空值并限制长度', () => {
    expect(rememberInput(['a', 'b'], ' a ')).toEqual(['b', 'a'])
    expect(rememberInput(['a'], '   ')).toEqual(['a'])
    expect(rememberInput(['a', 'b'], 'c', 2)).toEqual(['b', 'c'])
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

  it('验证：raw mode 下输入 y 后回车会确认权限而不是拒绝', async () => {
    const ui = new TerminalUi({ onSubmit: async () => undefined })
    const internals = ui as unknown as {
      active: boolean
      confirmation: { resolve: (allowed: boolean) => void } | undefined
      onKeypress: (value: string, key: unknown) => Promise<void> | void
    }
    internals.active = true

    const result = ui.confirm('run_command', { command: 'pnpm', args: ['test'] })
    await internals.onKeypress('y', { name: undefined })
    await internals.onKeypress('', { name: 'return' })

    await expect(result).resolves.toBe(true)
    expect(internals.confirmation).toBeUndefined()
  })

  it('验证：删除会话使用独立的二次确认提示', async () => {
    const ui = new TerminalUi({ onSubmit: async () => undefined })
    const internals = ui as unknown as {
      active: boolean
      confirmation: { prompt: string; resolve: (allowed: boolean) => void } | undefined
      onKeypress: (value: string, key: unknown) => Promise<void> | void
    }
    internals.active = true

    const result = ui.confirmAction('删除当前会话 abc？项目文件不会被修改')
    expect(internals.confirmation?.prompt).toContain('删除当前会话 abc')
    await internals.onKeypress('y', { name: undefined })

    await expect(result).resolves.toBe(true)
    expect(internals.confirmation).toBeUndefined()
  })

  it('验证：鼠标滚轮和点击 ANSI 序列不会进入输入缓冲区', () => {
    const ui = new TerminalUi({ onSubmit: async () => undefined })
    const internals = ui as unknown as {
      active: boolean
      inputBuffer: string
      onInputData: (value: string) => void
    }
    internals.active = true

    internals.onInputData('abc')
    internals.onInputData('\x1b[<65;46;16M')
    internals.onInputData('\x1b[<0;46;16M')

    expect(internals.inputBuffer).toBe('abc')
  })

  it('验证：用户滚动后新输出不会强制跳回底部', () => {
    const ui = new TerminalUi({ onSubmit: async () => undefined })
    const internals = ui as unknown as { scrollOffset: number }

    internals.scrollOffset = 3
    ui.addMessage({ role: 'assistant', content: 'new output' })
    expect(internals.scrollOffset).toBe(3)

    internals.scrollOffset = Number.MAX_SAFE_INTEGER
    ui.addMessage({ role: 'assistant', content: 'follow bottom' })
    expect(internals.scrollOffset).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('验证：助手文本和代码块使用不同的终端排版', () => {
    const lines = formatMessageForTerminal(
      { role: 'assistant', content: '' },
      '说明文字\n```ts\nconst answer = 42\n```\n结束',
      80,
    )

    expect(lines).toEqual([
      '说明文字',
      '\x1b[90m  ┌─ code (ts)\x1b[0m',
      '\x1b[90m  │ const answer = 42\x1b[0m',
      '\x1b[90m  └─\x1b[0m',
      '结束',
    ])
  })

  it('验证：助手 Markdown 的标题、行内样式、列表和引用会转换为 ANSI', () => {
    const lines = formatMessageForTerminal(
      { role: 'assistant', content: '' },
      '# 结果\n\n**通过**，使用 `pnpm test`。\n- 第一项\n1. 第二项\n> 这是补充说明',
      80,
    )

    expect(lines).toEqual([
      '\x1b[1;32m结果\x1b[0m',
      '',
      '\x1b[1m通过\x1b[22m，使用 \x1b[36mpnpm test\x1b[39m。',
      '• 第一项',
      '1. 第二项',
      '\x1b[90m│\x1b[0m 这是补充说明',
    ])
  })

  it('验证：助手输出中的 ANSI 控制序列会被清理', () => {
    expect(
      formatMessageForTerminal(
        { role: 'assistant', content: '' },
        '安全\x1b[2J文本\x1b]8;;https://evil.example\x07链接',
        80,
      ),
    ).toEqual(['安全文本链接'])

    expect(formatMessageForTerminal({ role: 'tool', content: '' }, '工具\x1b[2J输出', 80)).toEqual([
      '▸ 工具输出',
    ])
  })

  it('验证：行内 Markdown 先解析再换行，并保持样式边界', () => {
    const lines = formatMessageForTerminal(
      { role: 'assistant', content: '' },
      '**一二三四五六七八九十一** [文档](https://example.com/a-very-long-url)',
      16,
    )

    expect(lines).toEqual([
      '\x1b[1m一二三四五六七八九十\x1b[22m',
      '\x1b[1m一\x1b[22m \x1b[4;36m文档\x1b[24;39m',
    ])
  })

  it('验证：用户提示词使用明显的 You 样式', () => {
    expect(formatMessageForTerminal({ role: 'user', content: '' }, '读取项目', 80)).toEqual([
      '\x1b[1;36m▸ You:\x1b[0m 读取项目',
    ])
  })
})

describe('测试套件：首页 Banner', () => {
  it('验证：Banner 字形由等宽的 codeden 块状字母组成', () => {
    const lines = codedenBannerLines()
    expect(lines).toHaveLength(5)
    const widths = lines.map((line) => Array.from(line).length)
    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBeLessThanOrEqual(80)
    expect(lines.every((line) => /^[█ ]*$/u.test(line))).toBe(true)
  })

  it('验证：空会话首页渲染居中 Banner、标语与命令提示', () => {
    const lines = renderHomeBanner(80, 19)
    const visible = lines.map(stripAnsi)
    expect(visible.some((line) => line.includes('CodeDen · 会话式编程 Agent'))).toBe(true)
    expect(visible.some((line) => line.includes('/help 查看命令'))).toBe(true)
    expect(visible.some((line) => line.trim().length > 0)).toBe(true)
    expect(lines.every((line) => visibleLength(line) <= 80)).toBe(true)
  })

  it('验证：窄终端下 Banner 不越界且不抛错', () => {
    const lines = renderHomeBanner(30, 7)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => visibleLength(line) <= 30)).toBe(true)
  })
})
