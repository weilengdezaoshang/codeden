import { describe, expect, it, vi } from 'vitest'
import type { AgentPort } from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import { AgentSession } from '../../packages/agent-runtime/src/session/agent-session.js'
import { SessionStore } from '../../packages/agent-runtime/src/session/session-store.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { InMemorySecretRegistry } from '../../packages/core/src/security/secret-registry.js'
import { ResolvedSecret } from '../../packages/core/src/security/resolved-secret.js'
import { SecretRedactor } from '../../packages/core/src/security/secret-redactor.js'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'

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
    expect(await session.compactHistory(1)).toBe(1)
    expect(session.history).toHaveLength(2)
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
    await session.clearHistory()
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

  it('先异步构建任务，再用该任务构建本轮上下文', async () => {
    const order: string[] = []
    const agent = {
      name: 'prepared',
      run: vi.fn(async (task, context) => {
        order.push('run')
        expect(task.taskSpec.id).toBe('task-1')
        expect(context.runId).toBe('task-1-context')
        return { status: 'submitted' as const, finalResponse: 'ok', metrics: {} as never }
      }),
    } as AgentPort
    const session = new AgentSession(
      agent,
      async (_prompt, _turn, task) => {
        order.push('context')
        return { runId: `${task.taskSpec.id}-context` } as never
      },
      async (prompt, turn) => {
        order.push('task')
        await Promise.resolve()
        return { prompt, taskSpec: { id: `task-${turn}` } as never }
      },
    )

    await session.submit('异步准备')

    expect(order).toEqual(['task', 'context', 'run'])
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
      const first = new AgentSession(
        agent,
        createContext,
        createTask,
        Date.now,
        {
          store,
          sessionId: 'demo',
        },
        {
          settings: { provider: 'deepseek', model: 'deepseek-chat' },
        },
      )
      first.togglePlanMode()
      first.setPersona('简洁')
      first.setPermissionMode('auto')
      first.setActiveSkill('review')
      await first.submit('第一轮')

      const resumed = new AgentSession(agent, createContext, createTask, Date.now, {
        store,
        sessionId: 'demo',
      })
      expect(await resumed.resume()).toBe(true)
      expect(resumed.history).toHaveLength(1)
      expect(resumed.isPlanMode).toBe(true)
      expect(resumed.currentPersona).toBe('简洁')
      expect(resumed.currentPermissionMode).toBe('auto')
      expect(resumed.currentProvider).toBe('deepseek')
      expect(resumed.currentModel).toBe('deepseek-chat')
      expect(resumed.currentSkill).toBe('review')
      await resumed.submit('第二轮')
      expect(agent.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: '第二轮' }),
        expect.objectContaining({
          conversation: expect.arrayContaining([{ role: 'user', content: '第一轮' }]),
        }),
      )

      await resumed.clearHistory()
      const cleared = new AgentSession(agent, createContext, createTask, Date.now, {
        store,
        sessionId: 'demo',
      })
      expect(await cleared.resume()).toBe(true)
      expect(cleared.history).toHaveLength(0)
      expect(cleared.isPlanMode).toBe(true)
      expect(cleared.currentPersona).toBe('简洁')
      expect(cleared.currentPermissionMode).toBe('auto')
      expect(cleared.currentSkill).toBe('review')
      await cleared.submit('清空后新一轮')
      expect(agent.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: '清空后新一轮' }),
        expect.objectContaining({ conversation: [] }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：将本轮 Thinking、工具和验证事件保存为历史活动', async () => {
    const agent = {
      name: 'activity-agent',
      run: vi.fn(async (_task, context) => {
        await context.eventSink.emit('model', 'model.requested')
        await context.eventSink.emit('model', 'model.completed')
        await context.eventSink.emit('tool', 'tool.started', {
          callId: 'call-1',
          toolName: 'read_file',
        })
        await context.eventSink.emit('tool', 'tool.completed', {
          callId: 'call-1',
          toolName: 'read_file',
          durationMs: 12,
        })
        await context.eventSink.emit('verifier', 'verification.started')
        await context.eventSink.emit('verifier', 'verification.completed')
        return { status: 'submitted' as const, finalResponse: '完成', metrics: {} as never }
      }),
    } as AgentPort
    const session = new AgentSession(
      agent,
      () => ({ eventSink: new NoopEventSink() }) as never,
      (prompt) => ({ prompt, taskSpec: {} as never }),
    )

    await session.submit('检查项目')

    expect(session.history[0]?.activities).toEqual([
      { id: 'thinking-1', kind: 'thinking', label: 'Thinking', status: 'completed' },
      { id: 'tool-call-1', kind: 'tool', label: 'read_file', status: 'completed', durationMs: 12 },
      {
        id: 'verification-3',
        kind: 'verification',
        label: 'Verification',
        status: 'completed',
      },
    ])
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
        await readFile(
          path.join(root, '.codeden', 'sessions', 'race', 'chat_history.jsonl'),
          'utf8',
        ),
      ).not.toContain('session-secret-value')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：截断超大 Session 内容并保持记录可恢复', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-'))
    try {
      const store = new SessionStore(root)
      await store.save({
        schemaVersion: 1,
        sessionId: 'large',
        nextTurn: 1,
        planMode: false,
        persona: '',
        activeSkill: '',
        conversation: [{ role: 'assistant', content: 'x'.repeat(4_000_001) }],
        turns: [],
        updatedAt: new Date().toISOString(),
      })
      const restored = await store.load('large')
      expect(restored?.conversation[0]?.content).toContain('[truncated')
      expect(restored?.conversation[0]?.content.length).toBeLessThan(70_000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：持久化失败保留内存历史并可在后续保存中恢复', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue(undefined)
    const store = {
      save,
      startTurn: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    } as never
    const agent = {
      name: 'recovering-store',
      run: vi.fn(async () => ({
        status: 'submitted' as const,
        finalResponse: 'ok',
        metrics: {} as never,
      })),
    } as AgentPort
    const session = new AgentSession(
      agent,
      () => ({}) as never,
      (prompt) => ({ prompt, taskSpec: {} as never }),
      Date.now,
      { store, sessionId: 'recover' },
    )

    await session.submit('第一轮')
    expect(session.history).toHaveLength(1)
    expect(session.persistErrorMessage).toContain('disk unavailable')

    session.setPersona('简洁')
    await session.flush()
    expect(session.persistErrorMessage).toBeUndefined()
    expect(save).toHaveBeenCalledTimes(3)
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

  it('验证：恢复后再次压缩仍保留此前的压缩摘要', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-session-recompact-'))
    try {
      const store = new SessionStore(root)
      const summaries: string[][] = []
      const summarize = vi.fn(async (messages: readonly { content: string }[]) => {
        summaries.push(messages.map((message) => message.content))
        return `摘要-${summaries.length}`
      })
      const agent = {
        name: 'recompact',
        run: vi.fn(async () => ({
          status: 'submitted' as const,
          finalResponse: 'ok',
          metrics: {
            inputTokens: 10,
            outputTokens: 5,
            toolCalls: 1,
            costUsd: 0.01,
          } as never,
        })),
      } as AgentPort
      const create = () =>
        new AgentSession(
          agent,
          () => ({}) as never,
          (prompt) => ({ prompt, taskSpec: {} as never }),
          Date.now,
          { store, sessionId: 'recompact' },
          { summarize },
        )

      const original = create()
      await original.submit('最初任务')
      await original.submit('第二轮')
      await original.compactHistory(1)
      await original.flush()

      const resumed = create()
      expect(await resumed.resume()).toBe(true)
      await resumed.submit('第三轮')
      await resumed.compactHistory(1)

      expect(summaries[1]).toEqual(expect.arrayContaining([expect.stringContaining('摘要-1')]))
      expect(resumed.sessionTurnCount).toBe(3)
      expect(resumed.sessionMetrics).toEqual({
        inputTokens: 30,
        outputTokens: 15,
        toolCalls: 3,
        costUsd: 0.03,
      })
      const saved = await store.load('recompact')
      expect(saved).toEqual(
        expect.objectContaining({
          title: '最初任务',
          preview: '第三轮',
          totalTurnCount: 3,
          compactionNote: expect.stringContaining('摘要-2'),
        }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：摘要失败时保留原始模型上下文和完整历史', async () => {
    const conversations: unknown[] = []
    const agent = {
      name: 'failed-compaction',
      run: vi.fn(async (_task, context) => {
        conversations.push(context.conversation)
        return { status: 'submitted' as const, finalResponse: 'ok', metrics: {} as never }
      }),
    } as AgentPort
    const session = new AgentSession(
      agent,
      () => ({}) as never,
      (prompt) => ({ prompt, taskSpec: {} as never }),
      Date.now,
      undefined,
      { summarize: async () => Promise.reject(new Error('summary unavailable')) },
    )
    await session.submit('第一轮')
    await session.submit('第二轮')

    await expect(session.compactHistory(1)).rejects.toThrow('summarization failed')
    expect(session.history).toHaveLength(2)
    await session.submit('第三轮')
    expect(conversations[2]).toEqual(expect.arrayContaining([{ role: 'user', content: '第一轮' }]))
  })

  it('验证：多会话隔离上下文和设置，但始终读取共享工作区最新状态', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-shared-workspace-session-'))
    try {
      const store = new SessionStore(root)
      const workspace = { content: 'initial' }
      const observations: Array<{ prompt: string; content: string; conversation: unknown[] }> = []
      const agent = {
        name: 'shared-workspace',
        run: vi.fn(async (task, context) => {
          observations.push({
            prompt: task.prompt,
            content: workspace.content,
            conversation: context.conversation ?? [],
          })
          if (task.prompt.startsWith('write:')) {
            workspace.content = task.prompt.slice('write:'.length)
          }
          return { status: 'submitted' as const, finalResponse: 'ok', metrics: {} as never }
        }),
      } as AgentPort
      const create = (sessionId: string) =>
        new AgentSession(
          agent,
          () => ({ workspace }) as never,
          (prompt) => ({ prompt, taskSpec: {} as never }),
          Date.now,
          { store, sessionId },
        )

      const sessionA = create('a')
      sessionA.setPermissionMode('auto')
      await sessionA.submit('write:from-a')
      const sessionB = create('b')
      await sessionB.submit('write:from-b')
      const resumedA = create('a')
      await resumedA.resume()
      await resumedA.submit('read-current')

      expect(resumedA.currentPermissionMode).toBe('auto')
      expect(observations[1]?.conversation).toEqual([])
      expect(observations[2]?.content).toBe('from-b')
      expect(observations[2]?.conversation).toEqual(
        expect.arrayContaining([{ role: 'user', content: 'write:from-a' }]),
      )
      expect(observations[2]?.conversation).not.toEqual(
        expect.arrayContaining([{ role: 'user', content: 'write:from-b' }]),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
