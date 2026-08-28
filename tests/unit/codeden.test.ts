import { describe, expect, it, vi } from 'vitest'
import { main as codedenMain, shouldStartInteractive } from '../../src/cli/codeden.js'
import {
  DEFAULT_SESSION_ID,
  resolveSessionId,
  restoreSessionHistory,
} from '../../src/cli/agent-command.js'

describe('测试套件：codeden 会话入口', () => {
  it('验证：无任务文本时默认进入可恢复的交互模式', () => {
    expect(shouldStartInteractive([])).toBe(true)
    expect(shouldStartInteractive(['--workspace', '/tmp/project'])).toBe(true)
  })

  it('验证：带任务文本时保持一次性执行模式', () => {
    expect(shouldStartInteractive(['--workspace', '/tmp/project', '读取 package.json'])).toBe(false)
  })

  it('验证：指定会话时进入交互模式而不是一次性执行', () => {
    expect(shouldStartInteractive(['--session', 'work'])).toBe(true)
    expect(shouldStartInteractive(['--session=work', '继续上次任务'])).toBe(true)
  })

  it('验证：交互模式默认使用 default 会话', () => {
    expect(resolveSessionId(['--interactive'], true)).toBe(DEFAULT_SESSION_ID)
  })

  it('验证：session 参数可以切换会话', () => {
    expect(resolveSessionId(['--session', 'work'], true)).toBe('work')
  })

  it('验证：旧 resume 参数仍可兼容已有脚本', () => {
    expect(resolveSessionId(['--resume', 'legacy'], true)).toBe('legacy')
  })

  it('验证：一次性执行不隐式创建交互会话', () => {
    expect(resolveSessionId(['--prompt', '读取项目'], false)).toBeUndefined()
  })

  it('验证：恢复会话时将历史用户和助手消息重新放回界面', () => {
    const messages: Array<{ role: string; content: string }> = []
    restoreSessionHistory(
      { addMessage: (message) => messages.push(message) },
      [
        {
          prompt: '第一轮',
          result: { status: 'submitted', finalResponse: '第一轮答复', metrics: {} as never },
          startedAt: 1,
          completedAt: 2,
        },
        {
          prompt: '第二轮',
          result: { status: 'timeout', finalResponse: '', metrics: {} as never },
          startedAt: 3,
          completedAt: 4,
        },
      ],
      'default',
    )
    expect(messages).toEqual([
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '第一轮答复' },
      { role: 'user', content: '第二轮' },
      { role: 'system', content: 'Conversation restored: default' },
    ])
  })

  it('验证：帮助信息将默认恢复作为日常入口', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await expect(codedenMain(['--help'])).resolves.toBe(0)
      expect(output.mock.calls[0]?.[0]).toContain('restore the last conversation')
    } finally {
      output.mockRestore()
    }
  })
})
