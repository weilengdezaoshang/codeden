import { describe, expect, it, vi } from 'vitest'
import {
  doctor,
  initConfig,
  main as codedenMain,
  shouldStartInteractive,
} from '../../src/cli/codeden.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
