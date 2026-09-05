import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { emptyMetrics } from '../../packages/core/src/metrics.js'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import type { EventSink } from '../../packages/core/src/events/event-sink.js'
import type { RunEventSource } from '../../packages/core/src/events/run-event.js'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import type {
  AgentPort,
  AgentRunContext,
  AgentRunResult,
} from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import {
  AgentSession,
  type AgentSessionFoldOptions,
  type AgentSessionOptions,
} from '../../packages/agent-runtime/src/session/agent-session.js'
import { SessionStore } from '../../packages/agent-runtime/src/session/session-store.js'
import type { SessionSnapshot } from '../../packages/agent-runtime/src/session/session-store.js'
import { FoldProjectionStore } from '../../packages/agent-runtime/src/context/folding/fold-projection-store.js'
import type { FoldTrigger } from '../../packages/agent-runtime/src/context/folding/folded-memory.js'
import type { ContextBudgetPolicy } from '../../packages/agent-runtime/src/context/context-budget.js'

interface RecordedEvent {
  source: RunEventSource
  type: string
  data?: unknown
}

class CapturingEventSink implements EventSink {
  readonly events: RecordedEvent[] = []

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    this.events.push({ source, type, data })
  }
}

function fakeAgent(overrides: Partial<AgentRunResult> = {}): AgentPort {
  return {
    name: 'fake-agent',
    async run(): Promise<AgentRunResult> {
      return {
        status: 'verified_complete',
        finalResponse: 'done',
        metrics: emptyMetrics({
          turns: 1,
          modelRequests: 1,
          toolCalls: 0,
          toolFailures: 0,
          inputTokens: 1,
          outputTokens: 1,
        }),
        ...overrides,
      }
    },
  }
}

interface SessionHarness {
  session: AgentSession
  sink: CapturingEventSink
  root: string
}

async function makeSession(
  input: {
    foldPolicy?: ContextBudgetPolicy
    foldProfile?: { contextWindowTokens: number }
    summarize?: NonNullable<AgentSessionOptions['fold']>['summarize']
    persistenceRoot?: string
    foldRoot?: string
    agent?: AgentPort
    compactKeepTurns?: number
  } = {},
): Promise<SessionHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-fold-session-'))
  const sink = new CapturingEventSink()
  const fold: AgentSessionFoldOptions = {
    store: new FoldProjectionStore(input.foldRoot ?? root),
    eventSink: sink,
    ...(input.foldProfile ? { profile: input.foldProfile } : {}),
    ...(input.foldPolicy ? { policy: input.foldPolicy } : {}),
    ...(input.summarize ? { summarize: input.summarize } : {}),
  }
  const session = new AgentSession(
    input.agent ?? fakeAgent(),
    async () => testContext(sink),
    (prompt) => ({ prompt, taskSpec: parseTaskSpec({ id: 't', goal: prompt }) }),
    () => 1_000,
    input.persistenceRoot
      ? { store: new SessionStore(input.persistenceRoot), sessionId: 'session-1' }
      : undefined,
    { compactKeepTurns: input.compactKeepTurns ?? 1, fold },
  )
  return { session, sink, root }
}

function testContext(sink: EventSink): AgentRunContext {
  return {
    runId: 'run',
    trialId: 'trial',
    workspace: {
      root: process.cwd(),
      async changedPaths() {
        return []
      },
    },
    eventSink: sink,
    limits: { maxTurns: 5, maxToolCalls: 5 },
    submissionType: 'text',
    readOnly: true,
  }
}

const SMALL_WINDOW_POLICY: ContextBudgetPolicy = {
  utilizationThreshold: 0.7,
  estimateCoefficient: 4,
  reserveOutputTokens: 0,
  toolResultBudgetChars: Number.POSITIVE_INFINITY,
}

describe('测试套件：AgentSession 结构化折叠', () => {
  it('验证：手动折叠删除旧轮、注入结构化注记、落投影并发事件', async () => {
    const { session, sink, root } = await makeSession()
    await session.submit('任务一')
    await session.submit('任务二')
    await session.submit('任务三')

    const removed = await session.fold('manual')
    expect(removed).toBe(2)
    const conversation = session.conversationMessages
    expect(conversation[0]?.role).toBe('system')
    expect(conversation[0]?.content).toContain('Earlier conversation was folded')
    expect(conversation[0]?.content).toContain('任务一')
    // 折叠区间的最近目标作为 immediateGoal 保留在注记中。
    expect(conversation[0]?.content).toContain('任务二')
    // 注记之外只剩保留轮（任务三）的重放，任务二的原始消息已被移除。
    expect(
      conversation
        .slice(1)
        .map((message) => message.content)
        .join('\n'),
    ).not.toContain('任务二')
    // UI 历史不删（原始轮次可回溯）。
    expect(session.history).toHaveLength(3)

    const projection = await new FoldProjectionStore(root).load('session')
    expect(projection?.degraded).toBe(true)
    expect(projection?.memory.sourceSequenceRange).toEqual({ from: 1, to: 2 })
    const compacted = sink.events.find((event) => event.type === 'context.compacted')
    expect(compacted?.data).toMatchObject({
      ok: true,
      degraded: true,
      trigger: 'manual',
      removedTurns: 2,
    })
  })

  it('验证：LLM 摘要合法时 degraded=false 且锚点不被覆盖', async () => {
    const { session, root } = await makeSession({
      summarize: async () => ({
        currentProgress: 'LLM 总结的进度',
        currentChallenges: ['LLM 发现的阻塞'],
        nextActions: ['LLM 建议的下一步'],
      }),
    })
    await session.submit('任务一')
    await session.submit('任务二')
    await session.submit('任务三')
    await session.fold('manual')
    const note = session.conversationMessages[0]?.content ?? ''
    expect(note).toContain('LLM 总结的进度')
    expect(note).toContain('LLM 发现的阻塞')
    expect(note).toContain('任务一')
    expect(note).not.toContain('degraded=deterministic fallback')
    const projection = await new FoldProjectionStore(root).load('session')
    expect(projection?.degraded).toBe(false)
  })

  it('验证：摘要抛错或非法输出时确定性回退（degraded=true）且折叠不失败（EX-10/11）', async () => {
    // 第二个摘要器返回非法草稿（currentProgress 必须是非空字符串），运行时应被 schema 拒绝。
    const brokenSummarizers: Array<NonNullable<AgentSessionOptions['fold']>['summarize']> = [
      async () => {
        throw new Error('模型超时')
      },
      (async () => ({ currentProgress: 123 })) as unknown as NonNullable<
        AgentSessionOptions['fold']
      >['summarize'],
    ]
    for (const brokenSummarize of brokenSummarizers) {
      const { session, sink } = await makeSession({ summarize: brokenSummarize })
      await session.submit('任务一')
      await session.submit('任务二')
      await session.submit('任务三')
      const removed = await session.fold('manual')
      expect(removed).toBe(2)
      const note = session.conversationMessages[0]?.content ?? ''
      expect(note).toContain('degraded=deterministic fallback')
      expect(sink.events.at(-1)?.data).toMatchObject({ ok: true, degraded: true })
    }
  })

  it('验证：占用达到阈值时 submit 前自动折叠（EX-9）', async () => {
    const { session, sink } = await makeSession({
      foldPolicy: SMALL_WINDOW_POLICY,
      foldProfile: { contextWindowTokens: 500 },
    })
    // 每轮注入约 1200 字符：第 3 次 submit 前占用超过 0.7×500 tokens。
    const longPrompt = 'x'.repeat(1_200)
    await session.submit(longPrompt)
    await session.submit(longPrompt)
    const messagesBefore = session.conversationMessages.length
    await session.submit(longPrompt)
    const autoEvent = sink.events.find(
      (event) =>
        event.type === 'context.compacted' &&
        (event.data as { trigger?: FoldTrigger })?.trigger === 'auto',
    )
    expect(autoEvent).toBeDefined()
    // 折叠移除旧轮（-2 消息）并新增注记（+1），新轮再 +2：净 +1。
    expect(session.conversationMessages.length).toBe(messagesBefore + 1)
    expect(session.conversationMessages[0]?.content).toContain('Earlier conversation was folded')
  })

  it('验证：上一轮熔断（repeatedToolCall）触发工具折叠', async () => {
    const { session, sink } = await makeSession({
      compactKeepTurns: 0,
      agent: fakeAgent({ status: 'submitted', stopReason: 'repeatedToolCall', finalResponse: '' }),
    })
    await session.submit('触发熔断的一轮')
    await session.submit('下一轮')
    const toolEvent = sink.events.find(
      (event) =>
        event.type === 'context.compacted' &&
        (event.data as { trigger?: FoldTrigger })?.trigger === 'tool',
    )
    expect(toolEvent).toBeDefined()
  })

  it('验证：持久化失败时回滚记忆与投影（主计划 9.20 事务）', async () => {
    const outer = await mkdtemp(path.join(tmpdir(), 'codeden-fold-persist-'))
    const blocker = path.join(outer, 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    try {
      const { session } = await makeSession({
        persistenceRoot: blocker,
        compactKeepTurns: 0,
      })
      await session.submit('任务一')
      await session.submit('任务二')
      const conversationBefore = session.conversationMessages.map((message) => message.content)
      await expect(session.fold('manual')).rejects.toThrow('Conversation fold was not saved')
      expect(session.conversationMessages.map((message) => message.content)).toEqual(
        conversationBefore,
      )
    } finally {
      await rm(outer, { recursive: true, force: true })
    }
  })

  it('验证：恢复时折叠投影损坏给出警告且不阻塞恢复', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-fold-recover-'))
    try {
      const sessionsDir = path.join(root, '.codeden', 'sessions', 'session-1')
      await mkdir(sessionsDir, { recursive: true })
      await writeFile(path.join(sessionsDir, 'fold-projection.json'), '{ broken', 'utf8')
      const { session } = await makeSession({ persistenceRoot: root, foldRoot: root })
      const restored = await session.resume(minimalSnapshot())
      expect(restored).toBe(true)
      expect(session.foldRecoveryWarnings).toHaveLength(1)
      expect(session.foldRecoveryWarnings[0]).toContain('折叠投影损坏')
      // 未配置 fold 的会话不产生警告。
      const plain = new AgentSession(
        fakeAgent(),
        async () => testContext(new NoopEventSink()),
        (prompt) => ({ prompt, taskSpec: parseTaskSpec({ id: 't', goal: prompt }) }),
        () => 1_000,
        undefined,
        {},
      )
      expect(plain.foldRecoveryWarnings).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function minimalSnapshot(): SessionSnapshot {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    nextTurn: 1,
    planMode: false,
    persona: '',
    activeSkill: '',
    conversation: [],
    turns: [],
    updatedAt: new Date().toISOString(),
  }
}
