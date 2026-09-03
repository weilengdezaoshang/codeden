import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
