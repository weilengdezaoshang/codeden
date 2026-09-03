import { describe, expect, it, vi } from 'vitest'
import {
  doctor,
  initConfig,
  main as codedenMain,
  shouldStartInteractive,
} from '../../apps/agent/src/codeden.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseChangeCommand,
  clearInteractiveSessionRunState,
  formatSessionSummaries,
  parsePermissionCommand,
  parseSessionCommand,
  resolveSessionId,
  restoreSessionHistory,
} from '../../apps/agent/src/agent-command.js'
import type { UiMessage } from '../../apps/agent/src/terminal-ui.js'

describe('测试套件：codeden 会话入口', () => {
  it('显式评测子命令可转交独立应用并保留退出状态', async () => {
    const evaluate = vi.fn().mockResolvedValue(2)
    await expect(codedenMain(['eval', '--case', 'demo.yaml'], evaluate)).resolves.toBe(2)
    expect(evaluate).toHaveBeenCalledExactlyOnceWith(['--case', 'demo.yaml'])
  })

  it('普通帮助入口不加载评测应用', async () => {
    const evaluate = vi.fn()
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await expect(codedenMain(['--help'], evaluate)).resolves.toBe(0)
      expect(evaluate).not.toHaveBeenCalled()
    } finally {
      output.mockRestore()
    }
  })
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

  it('验证：交互模式不隐式指定会话，由启动器选择最近会话', () => {
    expect(resolveSessionId(['--interactive'], true)).toBeUndefined()
  })

  it('验证：session 参数可以切换会话', () => {
    expect(resolveSessionId(['--session', 'work'], true)).toBe('work')
  })

  it('验证：旧 resume 参数仍可兼容已有脚本', () => {
    expect(resolveSessionId(['--resume', 'legacy'], true)).toBe('legacy')
  })

  it('验证：交互会话支持新建和恢复命令', () => {
    expect(parseSessionCommand('/new')).toEqual({ type: 'new' })
    expect(parseSessionCommand('/clear')).toEqual({ type: 'clear' })
    expect(parseSessionCommand('/delete')).toEqual({ type: 'delete' })
    expect(parseSessionCommand('/session clear')).toEqual({ type: 'delete' })
    expect(parseSessionCommand('/resume')).toEqual({ type: 'list' })
    expect(parseSessionCommand('/sessions')).toEqual({ type: 'list' })
    expect(parseSessionCommand('/resume abc')).toEqual({ type: 'resume', sessionId: 'abc' })
    expect(parseSessionCommand('/resume   ')).toEqual({ type: 'list' })
    expect(parseSessionCommand('/resumes abc')).toBeUndefined()
  })

  it('验证：权限模式命令仅接受 ask 和 auto', () => {
    expect(parsePermissionCommand('/permission')).toEqual({ type: 'show' })
    expect(parsePermissionCommand('/permission ask')).toEqual({ type: 'set', value: 'ask' })
    expect(parsePermissionCommand('/permission auto')).toEqual({ type: 'set', value: 'auto' })
    expect(parsePermissionCommand('/permission unsafe')).toBeUndefined()
  })

  it('验证：切换会话时清除来源会话的结果和验证快照', () => {
    const state = {
      lastResult: { status: 'verified_complete' as const } as never,
      verifiedWorkspaceSnapshot: { schemaVersion: 1 } as never,
    }

    clearInteractiveSessionRunState(state)

    expect(state.lastResult).toBeUndefined()
    expect(state.verifiedWorkspaceSnapshot).toBeUndefined()
  })

  it('验证：解析交互变更管理命令并拒绝未知命令', () => {
    expect(parseChangeCommand('/diff')).toBe('diff')
    expect(parseChangeCommand('/apply')).toBe('apply')
    expect(parseChangeCommand('/discard')).toBe('discard')
    expect(parseChangeCommand('/undo')).toBeUndefined()
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
      { role: 'system', content: '会话已恢复：default' },
    ])
  })

  it('验证：恢复会话时将活动节点作为默认折叠的灰色记录显示', () => {
    const messages: UiMessage[] = []
    restoreSessionHistory(
      { addMessage: (message) => messages.push(message) },
      [
        {
          prompt: '检查项目',
          result: { status: 'submitted', finalResponse: '完成', metrics: {} as never },
          startedAt: 1,
          completedAt: 2,
          activities: [
            { id: 'thinking-1', kind: 'thinking', label: 'Thinking', status: 'completed' },
            { id: 'tool-call-1', kind: 'tool', label: 'read_file', status: 'completed' },
          ],
        },
      ],
      'default',
    )

    expect(messages).toEqual([
      { role: 'user', content: '检查项目' },
      expect.objectContaining({
        role: 'system',
        content: '✓ 思考中',
        activity: true,
        collapsed: true,
      }),
      expect.objectContaining({
        role: 'tool',
        content: '✓ 读取文件',
        activity: true,
        collapsed: true,
      }),
      { role: 'assistant', content: '完成' },
      { role: 'system', content: '会话已恢复：default' },
    ])
  })

  it('验证：历史会话摘要包含标题、轮数和最近输入', () => {
    expect(
      formatSessionSummaries([
        {
          sessionId: 'abc',
          title: '修复登录',
          preview: '运行回归测试',
          turnCount: 2,
          updatedAt: '2026-09-01T09:00:00.000Z',
        },
      ]),
    ).toBe('历史会话（输入 /resume <id> 恢复）：\n• 修复登录  [abc] · 2 轮 · 运行回归测试')
  })

  it('验证：历史摘要会截断过长标题和预览', () => {
    const longText = 'x'.repeat(200)
    const rendered = formatSessionSummaries([
      { sessionId: 'abc', title: longText, preview: longText, turnCount: 1, updatedAt: '' },
    ])
    expect(rendered).not.toContain(longText)
    expect(rendered.match(new RegExp(`${'x'.repeat(63)}…`, 'gu'))).toHaveLength(2)
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

  it('验证：init 创建不含密钥的项目配置', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-init-'))
    try {
      await expect(initConfig(root)).resolves.toBe(0)
      const config = await readFile(path.join(root, '.codeden', 'config.yaml'), 'utf8')
      expect(config).toContain('name: DEEPSEEK_API_KEY')
      expect(config).not.toMatch(/sk-|xai-/iu)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：init 默认拒绝覆盖已有配置', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-init-'))
    try {
      const configPath = path.join(root, '.codeden', 'config.yaml')
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(configPath, 'existing', 'utf8')
      await expect(initConfig(root)).resolves.toBe(1)
      await expect(readFile(configPath, 'utf8')).resolves.toBe('existing')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：doctor 在缺少配置时返回失败', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-doctor-'))
    try {
      await expect(doctor(root)).resolves.toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
