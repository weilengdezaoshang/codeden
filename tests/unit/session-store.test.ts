import { describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SessionStore,
  type SessionSnapshot,
} from '../../packages/agent-runtime/src/session/session-store.js'

describe('测试套件：SessionStore 历史摘要', () => {
  it('验证：历史会话按最近更新时间倒序，并生成标题和预览', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-summary-'))
    try {
      const store = new SessionStore(root)
      await store.save(snapshot('older', '早期任务', '2026-09-01T08:00:00.000Z'))
      await store.save(snapshot('latest', '最近任务', '2026-09-01T09:00:00.000Z'))
      await writeFile(path.join(root, '.codeden', 'sessions', 'broken.json'), '{broken')

      await expect(store.listSummaries()).resolves.toEqual([
        {
          sessionId: 'latest',
          title: '最近任务',
          preview: '最近任务',
          turnCount: 1,
          updatedAt: '2026-09-01T09:00:00.000Z',
        },
        {
          sessionId: 'older',
          title: '早期任务',
          preview: '早期任务',
          turnCount: 1,
          updatedAt: '2026-09-01T08:00:00.000Z',
        },
      ])
      await expect(store.latestSessionId()).resolves.toBe('latest')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：删除会话后列表和恢复均不可见', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-delete-'))
    try {
      const store = new SessionStore(root)
      await store.save(snapshot('deleted', '待删除任务', '2026-09-01T09:00:00.000Z'))

      await store.clear('deleted')

      await expect(store.load('deleted')).resolves.toBeUndefined()
      await expect(store.list()).resolves.not.toContain('deleted')
      const trash = await readdir(path.join(root, '.codeden', 'sessions', '.trash'))
      expect(trash.some((entry) => entry.startsWith('deleted-'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：使用四文件目录并忽略旧单 JSON 会话', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-layout-'))
    try {
      const store = new SessionStore(root)
      await store.save(snapshot('layout', '目录格式', '2026-09-01T09:00:00.000Z'))
      const directory = path.join(root, '.codeden', 'sessions', 'layout')
      await expect(readdir(directory)).resolves.toEqual(
        expect.arrayContaining([
          'summary.json',
          'updates.jsonl',
          'chat_history.jsonl',
          'settings.json',
        ]),
      )
      await writeFile(path.join(root, '.codeden', 'sessions', 'legacy.json'), '{}')
      await expect(store.list()).resolves.toEqual(['layout'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：忽略 JSONL 损坏尾行但拒绝中间损坏', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-corruption-'))
    try {
      const store = new SessionStore(root)
      await store.save(snapshot('tail', '可恢复', '2026-09-01T09:00:00.000Z'))
      const chat = path.join(root, '.codeden', 'sessions', 'tail', 'chat_history.jsonl')
      await appendFile(chat, '{"schemaVersion":1')
      await expect(store.load('tail')).resolves.toMatchObject({ sessionId: 'tail' })

      const valid = await readFile(chat, 'utf8')
      await writeFile(chat, `${valid.split('\n')[0]}\n{broken\n${valid.split('\n')[0]}\n`)
      await expect(store.load('tail')).rejects.toThrow('Corrupted session log')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：设置损坏时恢复安全权限默认值', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-settings-'))
    try {
      const store = new SessionStore(root)
      await store.save(snapshot('safe', '安全恢复', '2026-09-01T09:00:00.000Z'))
      await writeFile(path.join(root, '.codeden', 'sessions', 'safe', 'settings.json'), '{broken')
      await expect(store.load('safe')).resolves.toMatchObject({
        permissionMode: 'ask',
        planMode: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：拒绝加载高于当前版本的设置格式', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-future-settings-'))
    try {
      const store = new SessionStore(root)
      await store.save(snapshot('future', '未来格式', '2026-09-01T09:00:00.000Z'))
      await writeFile(
        path.join(root, '.codeden', 'sessions', 'future', 'settings.json'),
        JSON.stringify({ schemaVersion: 2 }),
      )

      await expect(store.load('future')).rejects.toThrow(
        'Unsupported session settings schema version: 2',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：崩溃遗留的未提交 generation 不会覆盖已提交会话', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-transaction-'))
    try {
      const store = new SessionStore(root)
      const committed = {
        ...snapshot('transaction', '已提交任务', '2026-09-01T09:00:00.000Z'),
        permissionMode: 'auto' as const,
      }
      await store.save(committed)
      const directory = path.join(root, '.codeden', 'sessions', 'transaction')
      const orphan = snapshot('transaction', '未提交任务', '2026-09-01T10:00:00.000Z')
      await appendFile(
        path.join(directory, 'updates.jsonl'),
        recordLine(2, {
          commitId: 'orphan-generation',
          type: 'turn_completed',
          turn: orphan.turns[0],
        }),
      )
      await appendFile(
        path.join(directory, 'chat_history.jsonl'),
        recordLine(2, {
          commitId: 'orphan-generation',
          type: 'context_snapshot',
          turnCount: 1,
          snapshot: { ...orphan, turns: [] },
        }),
      )
      await writeFile(
        path.join(directory, 'settings.json'),
        JSON.stringify({
          schemaVersion: 1,
          commitId: 'orphan-generation',
          permissionMode: 'ask',
        }),
      )

      await expect(store.load('transaction')).resolves.toMatchObject({
        updatedAt: committed.updatedAt,
        permissionMode: 'auto',
        turns: [expect.objectContaining({ prompt: '已提交任务' })],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：清空历史后持久化文件不再包含旧会话正文', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-clear-history-'))
    try {
      const store = new SessionStore(root)
      await store.save(snapshot('cleared', '不可残留的旧正文', '2026-09-01T09:00:00.000Z'))
      await store.save({
        ...snapshot('cleared', '占位', '2026-09-01T10:00:00.000Z'),
        nextTurn: 1,
        conversation: [],
        turns: [],
        contextTurns: [],
        title: undefined,
        preview: undefined,
        totalTurnCount: 0,
      })
      const directory = path.join(root, '.codeden', 'sessions', 'cleared')
      const contents = await Promise.all(
        ['summary.json', 'updates.jsonl', 'chat_history.jsonl', 'settings.json'].map((file) =>
          readFile(path.join(directory, file), 'utf8'),
        ),
      )

      expect(contents.join('\n')).not.toContain('不可残留的旧正文')
      await expect(store.load('cleared')).resolves.toMatchObject({ turns: [], conversation: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：恢复只有开始记录的中断轮次且不加入模型上下文', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-interrupted-'))
    try {
      const store = new SessionStore(root)
      await store.save({
        ...snapshot('interrupted', '占位', '2026-09-01T09:00:00.000Z'),
        nextTurn: 1,
        turns: [],
      })
      await store.startTurn('interrupted', 'interrupted:1', '未完成任务', 123)

      const restored = await store.load('interrupted')
      expect(restored?.turns).toEqual([
        expect.objectContaining({
          prompt: '未完成任务',
          result: expect.objectContaining({ stopReason: 'interrupted' }),
        }),
      ])
      expect(restored?.conversation).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：摘要优先使用不受压缩影响的持久化元数据', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-stable-summary-'))
    try {
      const store = new SessionStore(root)
      await store.save({
        ...snapshot('stable', '压缩后保留的任务', '2026-09-01T09:00:00.000Z'),
        title: '最初任务',
        preview: '最新任务',
        totalTurnCount: 12,
      })

      await expect(store.listSummaries()).resolves.toEqual([
        {
          sessionId: 'stable',
          title: '最初任务',
          preview: '最新任务',
          turnCount: 12,
          updatedAt: '2026-09-01T09:00:00.000Z',
        },
      ])
      await expect(store.load('stable')).resolves.toMatchObject({
        totalTurnCount: 12,
        turns: [expect.objectContaining({ prompt: '压缩后保留的任务' })],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function snapshot(sessionId: string, prompt: string, updatedAt: string): SessionSnapshot {
  return {
    schemaVersion: 1 as const,
    sessionId,
    nextTurn: 2,
    planMode: false,
    persona: '',
    activeSkill: '',
    conversation: [],
    turns: [
      {
        prompt,
        result: { status: 'submitted' as const, finalResponse: '', metrics: {} as never },
        startedAt: 1,
        completedAt: 2,
      },
    ],
    updatedAt,
  }
}

function recordLine(sequence: number, payload: unknown): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    sequence,
    timestamp: '2026-09-01T10:00:00.000Z',
    payload,
  })}\n`
}
