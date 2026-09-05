import { describe, expect, it, vi } from 'vitest'
import {
  statusForEvent,
  summarizeEvent,
  TerminalUiEventSink,
  toolPermissionPrompt,
} from '../../apps/agent/src/terminal-ui-event-sink.js'

describe('测试套件：statusForEvent', () => {
  it.each([
    ['verification.started', '正在验证'],
    ['tool.called', '正在使用工具'],
    ['tool.failed', '工具调用失败'],
    ['model.completed', '已完成'],
    ['agent.started', '运行中'],
    ['unknown.event', '处理中'],
    ['model.requested', '思考中'],
  ])('验证：%s -> %s', (type, expected) => {
    expect(statusForEvent(type)).toBe(expected)
  })

  it('验证：工具事件显示本地化摘要而不输出原始参数', () => {
    expect(
      summarizeEvent('tool.started', { toolName: 'read_file', arguments: { path: 'a.ts' } }),
    ).toBe('▶ 正在读取文件 a.ts')
    expect(
      summarizeEvent('tool.completed', {
        toolName: 'read_file',
        arguments: { path: 'a.ts' },
        durationMs: 12.4,
      }),
    ).toBe('✓ 已读取文件 a.ts（12ms）')
    expect(
      summarizeEvent('tool.failed', {
        toolName: 'write_file',
        arguments: { path: 'result.txt' },
        error: { message: 'denied' },
      }),
    ).toBe('✗ 写入文件失败 result.txt：denied')
  })

  it('验证：工具摘要能提取命令、查询和网页域名', () => {
    expect(
      summarizeEvent('tool.started', {
        toolName: 'run_command',
        arguments: { command: 'pnpm', args: ['test'] },
      }),
    ).toBe('▶ 正在运行命令 pnpm test')
    expect(
      summarizeEvent('tool.started', {
        toolName: 'search_docs',
        arguments: { query: 'Next.js routing' },
      }),
    ).toBe('▶ 正在搜索文档 “Next.js routing”')
    expect(
      summarizeEvent('tool.started', {
        toolName: 'fetch_url',
        arguments: { url: 'https://nextjs.org/docs' },
      }),
    ).toBe('▶ 正在读取网页 nextjs.org')
    expect(summarizeEvent('tool.started', { toolName: 'plugin_tool' })).toBe(
      '▶ 正在调用工具 plugin_tool',
    )
  })

  it('验证：工具完成事件会复用开始事件的参数', async () => {
    const ui = {
      setStatus: vi.fn(),
      upsertActivity: vi.fn(),
      addMessage: vi.fn(),
      appendAssistantDelta: vi.fn(),
      finishAssistantStream: vi.fn(),
      beginAssistantStream: vi.fn(),
    }
    const sink = new TerminalUiEventSink(ui as never)

    await sink.emit('tool', 'tool.started', {
      callId: 'call-1',
      toolName: 'read_file',
      arguments: { path: 'src/app.ts' },
    })
    await sink.emit('tool', 'tool.completed', {
      callId: 'call-1',
      toolName: 'read_file',
      durationMs: 7,
    })

    expect(ui.upsertActivity).toHaveBeenNthCalledWith(
      2,
      'tool:call-1',
      '✓ 已读取文件 src/app.ts（7ms）',
    )
  })

  it('验证：权限申请只展示安全且相关的工具摘要', () => {
    expect(
      toolPermissionPrompt('edit_file', {
        path: 'src/app.ts',
        oldText: '不应展示的旧内容',
        newText: '不应展示的新内容',
      }),
    ).toBe('即将修改文件 src/app.ts')
    expect(
      toolPermissionPrompt('run_command', {
        command: 'pnpm',
        args: ['test', '--run'],
      }),
    ).toBe('即将运行命令 pnpm test --run')
  })

  it('验证：模型生命周期和内部指令事件不重复占用消息区', () => {
    expect(summarizeEvent('model.completed', { turn: 1 })).toBe('')
    expect(summarizeEvent('agent.instructions_loaded', { files: ['SOUL.md'] })).toBe('')
    expect(summarizeEvent('agent.completed', { status: 'completed' })).toBe('')
  })

  it('验证：使用运行时的 passed 字段显示验证通过', () => {
    expect(summarizeEvent('verification.completed', { passed: true })).toBe('✓ Verification passed')
  })
})
