import { describe, expect, it, vi } from 'vitest'
import type { AgentPort } from '../../src/eval/ports/agent.port.js'
import { AgentSession } from '../../src/runtime/session/agent-session.js'
import { SessionStore } from '../../src/runtime/session/session-store.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { InMemorySecretRegistry } from '../../src/security/secret-registry.js'
import { ResolvedSecret } from '../../src/security/resolved-secret.js'
import { SecretRedactor } from '../../src/security/secret-redactor.js'

describe('测试套件：AgentSession', () => {
  it('串行执行并将上一轮对话传给下一轮', async () => {
    const contexts: unknown[] = []
    const agent = {
      name: 'fake',
      run: vi.fn(async (_task, context) => {
        contexts.push(context.conversation)
        return {
          status: 'submitted' as const,
          finalResponse: 'reply-' + contexts.length,
          metrics: {} as never,
        }
      }),
    } as AgentPort
    const session = new AgentSession(
      agent,
      () => ({}) as never,
      (prompt) => ({ prompt, taskSpec: {} as never }),
      (() => {
        let now = 0
        return () => ++now
      })(),
    )

    await Promise.all([session.submit(' first '), session.submit('second')])

    expect(agent.run).toHaveBeenCalledTimes(2)
    expect(contexts[0]).toEqual([])
    expect(contexts[1]).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
    ])
    expect(session.history).toHaveLength(2)
    expect(session.compactHistory(1)).toBe(1)
    expect(session.history).toHaveLength(1)
    await session.submit('after compact')
    expect(agent.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: 'after compact' }),
      expect.objectContaining({
        conversation: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('compacted'),
          }),
        ]),
      }),
    )
    session.clearHistory()
    expect(session.history).toHaveLength(0)
    const third = await session.submit('third')
    expect(third.result.status).toBe('submitted')
    expect(agent.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: 'third' }),
      expect.objectContaining({ conversation: [] }),
    )
    session.close()
    await expect(session.submit('fourth')).rejects.toThrow('closed')
  })

  it('将 Session 人格偏好传给每一轮 Agent', async () => {
    const contexts: Array<{ persona?: string }> = []
    const agent = {
      name: 'fake-persona',
      run: vi.fn(async (_task, context) => {
        contexts.push(context)
        return { status: 'submitted' as const, finalResponse: 'ok', metrics: {} as never }
      }),
    } as AgentPort
    const session = new AgentSession(
      agent,
      () => ({}) as never,
      (prompt) => ({ prompt, taskSpec: {} as never }),
    )
    session.setPersona('  concise  ')
    await session.submit('task')
    expect(session.currentPersona).toBe('concise')
    expect(contexts[0]?.persona).toBe('concise')
  })

  it('限制 Session 人格长度', () => {
    const session = new AgentSession(
      {} as AgentPort,
      () => ({}) as never,
      () => ({}) as never,
    )
    session.setPersona('x'.repeat(5_000))
    expect(session.currentPersona).toHaveLength(4_000)
  })

  it('验证：保存并恢复 Session 对话、模式和下一轮序号', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-'))
    try {
      const store = new SessionStore(root)
      const agent = {
        name: 'persisted',
        run: vi.fn(async (_task, _context) => ({
          status: 'submitted' as const,
          finalResponse: '已恢复',
          metrics: {} as never,
        })),
      } as AgentPort
      const createContext = () => ({}) as never
      const createTask = (prompt: string) => ({ prompt, taskSpec: {} as never })
      const first = new AgentSession(agent, createContext, createTask, Date.now, {
        store,
        sessionId: 'demo',
      })
      first.togglePlanMode()
      first.setPersona('简洁')
      await first.submit('第一轮')

      const resumed = new AgentSession(agent, createContext, createTask, Date.now, {
        store,
        sessionId: 'demo',
      })
      expect(await resumed.resume()).toBe(true)
      expect(resumed.history).toHaveLength(1)
      expect(resumed.isPlanMode).toBe(true)
      expect(resumed.currentPersona).toBe('简洁')
      await resumed.submit('第二轮')
      expect(agent.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: '第二轮' }),
        expect.objectContaining({
          conversation: expect.arrayContaining([{ role: 'user', content: '第一轮' }]),
        }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：清理排队保存并脱敏持久化内容', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-'))
    try {
      const registry = new InMemorySecretRegistry()
      const secret = new ResolvedSecret('session-secret-value')
      registry.register(secret)
      const store = new SessionStore(root, new SecretRedactor(registry))
      const snapshot = {
        schemaVersion: 1 as const,
        sessionId: 'race',
        nextTurn: 1,
        planMode: false,
        persona: '',
        activeSkill: '',
        conversation: [{ role: 'assistant' as const, content: 'session-secret-value' }],
        turns: [],
        updatedAt: new Date().toISOString(),
      }
      await Promise.all([store.save(snapshot), store.clear('race')])
      expect(await store.load('race')).toBeUndefined()
      await store.save(snapshot)
      expect(
        await readFile(path.join(root, '.codeden', 'sessions', 'race.json'), 'utf8'),
      ).not.toContain('session-secret-value')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：取消正在执行的 Agent 请求', async () => {
    let signal: AbortSignal | undefined
    const agent = {
      name: 'cancellable',
      run: vi.fn(async (_task, context) => {
        signal = context.abortSignal
        await new Promise<void>((resolve) =>
          context.abortSignal?.addEventListener('abort', () => resolve(), { once: true }),
        )
        return { status: 'timeout' as const, finalResponse: '', metrics: {} as never }
      }),
    } as AgentPort
    const session = new AgentSession(
      agent,
      () => ({}) as never,
      (prompt) => ({ prompt, taskSpec: {} as never }),
    )
    const pending = session.submit('可取消任务')
    await new Promise((resolve) => setImmediate(resolve))
    expect(session.cancel()).toBe(true)
    await pending
    expect(signal?.aborted).toBe(true)
    expect(session.cancel()).toBe(false)
  })

  it('验证：重置会话时清空历史、模式、人格和技能状态', async () => {
    const contexts: Array<{ conversation?: unknown; readOnly?: boolean; persona?: string }> = []
    const agent = {
      name: 'resettable',
      run: vi.fn(async (_task, context) => {
        contexts.push(context)
        return { status: 'submitted' as const, finalResponse: 'ok', metrics: {} as never }
      }),
    } as AgentPort
    const session = new AgentSession(
      agent,
      () => ({}) as never,
      (prompt, turn) => ({ prompt, taskSpec: { id: `task-${turn}` } as never }),
    )
    session.togglePlanMode()
    session.setPersona('简洁')
    session.setActiveSkill('review')
    await session.submit('旧消息')

    session.reset()
    expect(session.history).toHaveLength(0)
    expect(session.isPlanMode).toBe(false)
    expect(session.currentPersona).toBe('')
    expect(session.currentSkill).toBe('')
    await session.submit('新消息')
    expect(contexts[1]).toEqual(
      expect.objectContaining({ conversation: [], readOnly: false, persona: '' }),
    )
  })

  it('验证：上下文过长时自动压缩历史', async () => {
    const contexts: unknown[] = []
    const agent = {
      name: 'compacting',
      run: vi.fn(async (_task, context) => {
        contexts.push(context.conversation)
        return {
          status: 'submitted' as const,
          finalResponse: 'x'.repeat(700),
          metrics: {} as never,
        }
      }),
    } as AgentPort
    const session = new AgentSession(
      agent,
      () => ({}) as never,
      (prompt) => ({ prompt, taskSpec: {} as never }),
      Date.now,
      undefined,
      { maxConversationChars: 1_000, compactKeepTurns: 1 },
    )
    await session.submit('a'.repeat(700))
    await session.submit('b'.repeat(700))
    expect(contexts[1]).toEqual(expect.any(Array))
    await session.submit('第三轮')
    expect(contexts[2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: expect.stringContaining('compacted') }),
      ]),
    )
  })
})
