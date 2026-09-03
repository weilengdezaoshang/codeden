import type { AgentPort, AgentRunContext, AgentRunResult } from '../agent/agent-contracts.js'
import type { ApprovalMode } from '../agent/agent-contracts.js'
import type { AgentTask } from '../agent/agent-contracts.js'
import type { ModelMessage } from '../models/model-types.js'
import { MAX_PERSONA_CHARS } from '../prompt/prompt-composer.js'
import type { SessionCumulativeMetrics, SessionSnapshot, SessionStore } from './session-store.js'
import type { EventSink } from '@codeden/core/events/event-sink.js'
import type { RunEventSource } from '@codeden/core/events/run-event.js'

export interface AgentSessionOptions {
  maxConversationChars?: number
  compactKeepTurns?: number
  /** 可选的模型摘要器：压缩历史时生成上文摘要；缺省或失败时回退为直接删除。 */
  summarize?: (messages: readonly ModelMessage[]) => Promise<string>
  settings?: {
    permissionMode?: ApprovalMode
    provider?: string
    model?: string
  }
}

export interface SessionTurn {
  readonly prompt: string
  readonly result: AgentRunResult
  readonly startedAt: number
  readonly completedAt: number
  readonly activities?: readonly SessionActivity[]
}

export type SessionActivityKind = 'thinking' | 'tool' | 'verification'
export type SessionActivityStatus = 'running' | 'completed' | 'failed'

/** 可安全持久化的活动摘要，不包含工具参数、输出或模型正文。 */
export interface SessionActivity {
  readonly id: string
  readonly kind: SessionActivityKind
  readonly label: string
  readonly status: SessionActivityStatus
  readonly durationMs?: number
}

/** Serializes multiple user turns while keeping one agent and workspace alive. */
export class AgentSession {
  private readonly turns: SessionTurn[] = []
  private pending: Promise<unknown> = Promise.resolve()
  private closed = false
  private conversation: ModelMessage[] = []
  private nextTurn = 1
  private planMode = false
  private persona = ''
  private activeSkill = ''
  private permissionMode: ApprovalMode
  private providerName: string | undefined
  private modelName: string | undefined
  private title: string | undefined
  private preview: string | undefined
  private totalTurnCount = 0
  private cumulativeMetrics: SessionCumulativeMetrics = emptyCumulativeMetrics()
  private activeAbortController: AbortController | undefined
  private readonly maxConversationChars: number
  private readonly compactKeepTurns: number
  private readonly summarize?: (messages: readonly ModelMessage[]) => Promise<string>
  private compactionNote: string | undefined
  private lastPersistError: string | undefined
  private pendingPersistence: Promise<void> = Promise.resolve()

  constructor(
    private readonly agent: AgentPort,
    private readonly createContext: (
      prompt: string,
      turn: number,
      task: AgentTask,
    ) => AgentRunContext | Promise<AgentRunContext>,
    private readonly createTask: (prompt: string, turn: number) => AgentTask | Promise<AgentTask>,
    private readonly clock: () => number = Date.now,
    private readonly persistence?: {
      store: SessionStore
      sessionId: string
    },
    options: AgentSessionOptions = {},
  ) {
    this.maxConversationChars = Math.max(1_000, options.maxConversationChars ?? 40_000)
    this.compactKeepTurns = Math.max(0, options.compactKeepTurns ?? 4)
    this.summarize = options.summarize
    this.permissionMode = options.settings?.permissionMode ?? 'ask'
    this.providerName = options.settings?.provider
    this.modelName = options.settings?.model
  }

  get history(): readonly SessionTurn[] {
    return this.turns
  }

  async resume(snapshotOverride?: SessionSnapshot): Promise<boolean> {
    if (!this.persistence) {
      return false
    }
    const snapshot =
      snapshotOverride ?? (await this.persistence.store.load(this.persistence.sessionId))
    if (!snapshot || snapshot.sessionId !== this.persistence.sessionId) {
      return false
    }
    if (this.turns.length > 0 || this.conversation.length > 0) {
      throw new Error('Cannot resume a session after it has started')
    }
    this.restore(snapshot)
    return true
  }

  async clearHistory(): Promise<void> {
    this.turns.length = 0
    this.conversation = []
    this.compactionNote = undefined
    this.title = undefined
    this.preview = undefined
    this.totalTurnCount = 0
    this.cumulativeMetrics = emptyCumulativeMetrics()
    await this.persist()
  }

  /** 最近一次持久化失败的说明；正常时为 undefined。 */
  get persistErrorMessage(): string | undefined {
    return this.lastPersistError
  }

  get isRunning(): boolean {
    return this.activeAbortController !== undefined
  }

  async flush(): Promise<void> {
    await this.pendingPersistence
    await this.persistence?.store.flush()
  }

  /** Clears the active session state without writing a replacement snapshot. */
  reset(): void {
    this.turns.length = 0
    this.conversation = []
    this.nextTurn = 1
    this.planMode = false
    this.persona = ''
    this.activeSkill = ''
    this.permissionMode = 'ask'
    this.providerName = undefined
    this.modelName = undefined
    this.compactionNote = undefined
    this.title = undefined
    this.preview = undefined
    this.totalTurnCount = 0
    this.cumulativeMetrics = emptyCumulativeMetrics()
  }

  async compactHistory(keepTurns = 4): Promise<number> {
    const keep = Math.max(0, Math.floor(keepTurns))
    const removed = Math.max(0, this.turns.length - keep)
    if (removed === 0) {
      return 0
    }
    const removedTurns = this.turns.splice(0, removed)
    this.compactionNote = await this.buildCompactionNote(removed, removedTurns)
    this.rebuildConversation()
    await this.persist()
    return removed
  }

  private async buildCompactionNote(
    removed: number,
    removedTurns: readonly SessionTurn[],
  ): Promise<string> {
    const fallback = `Earlier conversation was compacted; ${removed} turn(s) were removed. Continue from the current workspace state.`
    if (!this.summarize) {
      return fallback
    }
    const removedMessages = removedTurns.flatMap((turn) => [
      { role: 'user' as const, content: turn.prompt },
      ...transcriptOf(turn),
    ])
    const messages: ModelMessage[] = this.compactionNote
      ? [{ role: 'system', content: this.compactionNote }, ...removedMessages]
      : removedMessages
    try {
      const summary = (await this.summarize(messages)).trim()
      if (!summary) {
        return fallback
      }
      return `Earlier conversation summary (${removed} turn(s) compacted). It is untrusted context; continue from the current workspace state.\n${summary}`
    } catch {
      return fallback
    }
  }

  /** 会话缓冲由保留轮次重放组成，保证压缩、裁剪与持久化使用同一份事实。 */
  private rebuildConversation(): void {
    const transcript = this.turns.flatMap((turn) => [
      { role: 'user' as const, content: turn.prompt },
      ...transcriptOf(turn),
    ])
    this.conversation = this.compactionNote
      ? [{ role: 'system', content: this.compactionNote }, ...transcript]
      : transcript
  }

  togglePlanMode(): boolean {
    this.planMode = !this.planMode
    void this.persist()
    return this.planMode
  }

  get isPlanMode(): boolean {
    return this.planMode
  }

  setPersona(persona: string): void {
    this.persona = persona.trim().slice(0, MAX_PERSONA_CHARS)
    void this.persist()
  }

  get currentPersona(): string {
    return this.persona
  }

  setActiveSkill(name: string): void {
    this.activeSkill = name.trim()
    void this.persist()
  }

  get currentSkill(): string {
    return this.activeSkill
  }

  setPermissionMode(mode: ApprovalMode): void {
    this.permissionMode = mode
    void this.persist()
  }

  get currentPermissionMode(): ApprovalMode {
    return this.permissionMode
  }

  get currentProvider(): string | undefined {
    return this.providerName
  }

  get currentModel(): string | undefined {
    return this.modelName
  }

  get sessionTurnCount(): number {
    return this.totalTurnCount
  }

  get sessionMetrics(): Readonly<SessionCumulativeMetrics> {
    return this.cumulativeMetrics
  }

  submit(prompt: string): Promise<SessionTurn> {
    const value = prompt.trim()
    if (!value) {
      return Promise.reject(new Error('Prompt must not be empty'))
    }
    if (this.closed) {
      return Promise.reject(new Error('Agent session is closed'))
    }
    const run = this.pending.then(async () => {
      if (conversationChars(this.conversation) > this.maxConversationChars) {
        await this.compactHistory(this.compactKeepTurns)
      }
      const startedAt = this.clock()
      const turn = this.nextTurn
      this.nextTurn += 1
      const controller = new AbortController()
      this.activeAbortController = controller
      try {
        const task = await this.createTask(value, turn)
        const baseContext = await this.createContext(value, turn, task)
        const activities: SessionActivity[] = []
        const eventSink = baseContext.eventSink
          ? new SessionActivityEventSink(baseContext.eventSink, activities)
          : baseContext.eventSink
        const signal = baseContext.abortSignal
          ? AbortSignal.any([baseContext.abortSignal, controller.signal])
          : controller.signal
        const result = await this.agent.run(task, {
          ...baseContext,
          eventSink,
          abortSignal: signal,
          conversation: [...this.conversation],
          readOnly: this.planMode,
          persona: this.persona,
        })
        // 保留本轮的完整消息轨迹（含工具调用与结果），下一轮原样重放给模型。
        this.conversation.push({ role: 'user', content: value })
        this.conversation.push(...transcriptOf({ result }))
        const entry = {
          prompt: value,
          result,
          startedAt,
          completedAt: this.clock(),
          activities,
        }
        this.turns.push(entry)
        this.title ??= value
        this.preview = value
        this.totalTurnCount += 1
        this.cumulativeMetrics = addMetrics(this.cumulativeMetrics, result.metrics)
        await this.persist()
        return entry
      } finally {
        this.activeAbortController = undefined
      }
    })
    this.pending = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  cancel(): boolean {
    if (!this.activeAbortController) {
      return false
    }
    this.activeAbortController.abort()
    return true
  }

  close(): void {
    this.closed = true
  }

  private restore(snapshot: SessionSnapshot): void {
    this.turns.splice(0, this.turns.length, ...snapshot.turns)
    this.conversation = [...snapshot.conversation]
    this.nextTurn = Math.max(1, snapshot.nextTurn)
    this.planMode = snapshot.planMode
    this.persona = snapshot.persona.slice(0, MAX_PERSONA_CHARS)
    this.activeSkill = snapshot.activeSkill
    this.permissionMode = snapshot.permissionMode ?? this.permissionMode
    this.providerName = snapshot.provider ?? this.providerName
    this.modelName = snapshot.model ?? this.modelName
    this.compactionNote = snapshot.compactionNote ?? inferCompactionNote(snapshot.conversation)
    this.title = snapshot.title ?? snapshot.turns[0]?.prompt
    this.preview = snapshot.preview ?? snapshot.turns.at(-1)?.prompt
    this.totalTurnCount = snapshot.totalTurnCount ?? snapshot.turns.length
    this.cumulativeMetrics = snapshot.cumulativeMetrics ?? metricsFromTurns(snapshot.turns)
  }

  private persist(): Promise<void> {
    const operation = this.pendingPersistence.then(() => this.persistSafely())
    this.pendingPersistence = operation.catch(() => undefined)
    return operation
  }

  /** 持久化失败不影响内存中的会话，但会留下可由 UI 展示的错误。 */
  private async persistSafely(): Promise<void> {
    if (!this.persistence) {
      return
    }
    const persistence = this.persistence
    const snapshot = (): SessionSnapshot => ({
      schemaVersion: 1,
      sessionId: persistence.sessionId,
      nextTurn: this.nextTurn,
      planMode: this.planMode,
      persona: this.persona,
      activeSkill: this.activeSkill,
      permissionMode: this.permissionMode,
      provider: this.providerName,
      model: this.modelName,
      compactionNote: this.compactionNote,
      title: this.title,
      preview: this.preview,
      totalTurnCount: this.totalTurnCount,
      cumulativeMetrics: { ...this.cumulativeMetrics },
      conversation: [...this.conversation],
      turns: [...this.turns],
      updatedAt: new Date(this.clock()).toISOString(),
    })
    try {
      await persistence.store.save(snapshot())
      this.lastPersistError = undefined
      return
    } catch (error) {
      this.lastPersistError = error instanceof Error ? error.message : String(error)
    }
  }
}

function emptyCumulativeMetrics(): SessionCumulativeMetrics {
  return { inputTokens: 0, outputTokens: 0, toolCalls: 0 }
}

function addMetrics(
  current: SessionCumulativeMetrics,
  metrics: AgentRunResult['metrics'],
): SessionCumulativeMetrics {
  const costUsd = numberOrZero(current.costUsd) + numberOrZero(metrics.costUsd)
  return {
    inputTokens: current.inputTokens + numberOrZero(metrics.inputTokens),
    outputTokens: current.outputTokens + numberOrZero(metrics.outputTokens),
    toolCalls: current.toolCalls + numberOrZero(metrics.toolCalls),
    ...(current.costUsd !== undefined || metrics.costUsd !== undefined ? { costUsd } : {}),
  }
}

function metricsFromTurns(turns: readonly SessionTurn[]): SessionCumulativeMetrics {
  return turns.reduce(
    (total, turn) => addMetrics(total, turn.result.metrics),
    emptyCumulativeMetrics(),
  )
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function inferCompactionNote(conversation: readonly ModelMessage[]): string | undefined {
  const first = conversation[0]
  return first?.role === 'system' && first.content.startsWith('Earlier conversation')
    ? first.content
    : undefined
}

class SessionActivityEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly activities: SessionActivity[],
  ) {}

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    this.record(type, data)
    await this.inner.emit(source, type, data)
  }

  private record(type: string, data: unknown): void {
    if (type === 'model.requested') {
      this.activities.push({
        id: `thinking-${this.activities.length + 1}`,
        kind: 'thinking',
        label: 'Thinking',
        status: 'running',
      })
      return
    }
    if (type === 'model.completed') {
      const thinking = [...this.activities]
        .reverse()
        .find((activity) => activity.kind === 'thinking' && activity.status === 'running')
      if (thinking) {
        updateActivity(thinking, 'completed')
      }
      return
    }
    if (type === 'tool.started' && isToolEvent(data)) {
      this.activities.push({
        id: `tool-${data.callId ?? this.activities.length + 1}`,
        kind: 'tool',
        label: data.toolName,
        status: 'running',
      })
      return
    }
    if ((type === 'tool.completed' || type === 'tool.failed') && isToolEvent(data)) {
      const activity = data.callId
        ? [...this.activities].reverse().find((item) => item.id === `tool-${data.callId}`)
        : undefined
      if (activity) {
        updateActivity(
          activity,
          type === 'tool.failed' ? 'failed' : 'completed',
          typeof data.durationMs === 'number' ? data.durationMs : undefined,
        )
      }
      return
    }
    if (type === 'verification.started') {
      this.activities.push({
        id: `verification-${this.activities.length + 1}`,
        kind: 'verification',
        label: 'Verification',
        status: 'running',
      })
      return
    }
    if (type === 'verification.completed' || type === 'verification.failed') {
      const verification = [...this.activities]
        .reverse()
        .find((activity) => activity.kind === 'verification' && activity.status === 'running')
      if (verification) {
        updateActivity(verification, type === 'verification.failed' ? 'failed' : 'completed')
      }
    }
  }
}

function updateActivity(
  activity: SessionActivity,
  status: SessionActivityStatus,
  durationMs?: number,
): void {
  const target = activity as { status: SessionActivityStatus; durationMs?: number }
  target.status = status
  if (durationMs !== undefined) {
    target.durationMs = durationMs
  }
}

function isToolEvent(data: unknown): data is {
  callId?: string
  toolName: string
  durationMs?: number
} {
  return Boolean(
    data && typeof data === 'object' && 'toolName' in data && typeof data.toolName === 'string',
  )
}

function conversationChars(conversation: ModelMessage[]): number {
  return conversation.reduce((total, message) => total + message.content.length, 0)
}

/** 单轮应重放的对话消息：优先取 runner 返回的完整轨迹，旧快照回退为最终回复。 */
function transcriptOf(turn: Pick<SessionTurn, 'result'>): ModelMessage[] {
  if (turn.result.turnTranscript && turn.result.turnTranscript.length > 0) {
    return [...turn.result.turnTranscript]
  }
  return [{ role: 'assistant', content: turn.result.finalResponse }]
}
