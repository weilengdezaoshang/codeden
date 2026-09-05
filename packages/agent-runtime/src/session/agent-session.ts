import type { AgentPort, AgentRunContext, AgentRunResult } from '../agent/agent-contracts.js'
import type { ApprovalMode } from '../agent/agent-contracts.js'
import type { AgentTask } from '../agent/agent-contracts.js'
import type { ModelMessage, ModelProfile } from '../models/model-types.js'
import { MAX_PERSONA_CHARS } from '../prompt/prompt-composer.js'
import type { SessionCumulativeMetrics, SessionSnapshot, SessionStore } from './session-store.js'
import type { EventSink } from '@codeden/core/events/event-sink.js'
import type { RunEventSource } from '@codeden/core/events/run-event.js'
import type { SecretRedactor } from '@codeden/core/security/secret-redactor.js'
import {
  CorruptedFoldProjectionError,
  FoldedSessionMemorySchema,
  FoldSummaryDraftSchema,
  renderFoldNote,
  type FoldSummaryDraft,
  type FoldTrigger,
  type FoldedSessionMemory,
} from '../context/folding/folded-memory.js'
import { FoldProjectionStore } from '../context/folding/fold-projection-store.js'
import {
  SessionFolder,
  validateFold,
  countFailedToolResults,
} from '../context/folding/session-folder.js'
import {
  computeUtilization,
  DEFAULT_CONTEXT_BUDGET_POLICY,
  resolveModelProfile,
  type ContextBudgetPolicy,
} from '../context/context-budget.js'

export interface AgentSessionOptions {
  maxConversationChars?: number
  compactKeepTurns?: number
  /** 可选的模型摘要器：压缩历史时生成上文摘要；缺省或失败时回退为直接删除。 */
  summarize?: (messages: readonly ModelMessage[]) => Promise<string>
  /** 结构化折叠（M2b）：配置后 submit 前按占用/熔断信号触发折叠，/fold 手动可用。 */
  fold?: AgentSessionFoldOptions
  settings?: {
    permissionMode?: ApprovalMode
    provider?: string
    model?: string
    reasoningEffort?: 'low' | 'medium' | 'high'
  }
}

export interface AgentSessionFoldOptions {
  store: FoldProjectionStore
  redactor?: SecretRedactor
  /** 折叠事件（context.compacted）出口；缺省不发事件。 */
  eventSink?: EventSink
  /** 触发阈值判定所用的模型窗口档案；缺省按保守默认。 */
  profile?: ModelProfile
  policy?: ContextBudgetPolicy
  /**
   * LLM 摘要增强：返回合法草稿则 degraded=false；抛错或非法输出由确定性路径
   * 兜底（degraded=true），不阻塞折叠。
   */
  summarize?: (input: {
    memory: FoldedSessionMemory
    transcriptTurns: number
  }) => Promise<FoldSummaryDraft | undefined>
}

export interface SessionTurn {
  readonly turnId?: string
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
  private readonly contextTurns: SessionTurn[] = []
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
  private reasoningEffort: 'low' | 'medium' | 'high' | undefined
  private title: string | undefined
  private createdAt: string | undefined
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
  private readonly foldOptions: AgentSessionFoldOptions | undefined
  private readonly folder = new SessionFolder()
  /** 最近一次 resume 时对折叠投影的校验警告；正常时为空数组。 */
  foldRecoveryWarnings: string[] = []

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
    this.foldOptions = options.fold
    this.permissionMode = options.settings?.permissionMode ?? 'ask'
    this.providerName = options.settings?.provider
    this.modelName = options.settings?.model
    this.reasoningEffort = options.settings?.reasoningEffort
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
    this.foldRecoveryWarnings = []
    if (this.foldOptions?.store) {
      try {
        await this.foldOptions.store.load(this.persistence.sessionId)
      } catch (error) {
        if (error instanceof CorruptedFoldProjectionError) {
          // 恢复语义：投影损坏时回退旧历史（快照本身有效），不采用损坏投影。
          this.foldRecoveryWarnings.push('折叠投影损坏，已按快照历史继续，不采用损坏投影。')
        }
      }
    }
    this.restore(snapshot)
    return true
  }

  async clearHistory(): Promise<void> {
    this.turns.length = 0
    this.contextTurns.length = 0
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
    this.contextTurns.length = 0
    this.conversation = []
    this.nextTurn = 1
    this.planMode = false
    this.persona = ''
    this.activeSkill = ''
    this.permissionMode = 'ask'
    this.providerName = undefined
    this.modelName = undefined
    this.reasoningEffort = undefined
    this.compactionNote = undefined
    this.title = undefined
    this.createdAt = undefined
    this.preview = undefined
    this.totalTurnCount = 0
    this.cumulativeMetrics = emptyCumulativeMetrics()
  }

  async compactHistory(keepTurns = 4): Promise<number> {
    const keep = Math.max(0, Math.floor(keepTurns))
    const removed = Math.max(0, this.contextTurns.length - keep)
    if (removed === 0) {
      return 0
    }
    const removedTurns = this.contextTurns.slice(0, removed)
    const previousNote = this.compactionNote
    const nextNote = await this.buildCompactionNote(removed, removedTurns)
    this.contextTurns.splice(0, removed)
    this.compactionNote = nextNote
    this.rebuildConversation()
    await this.persist()
    if (this.lastPersistError) {
      this.contextTurns.unshift(...removedTurns)
      this.compactionNote = previousNote
      this.rebuildConversation()
      throw new Error(`Conversation compaction was not saved: ${this.lastPersistError}`)
    }
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
    } catch (error) {
      throw new Error('Conversation summarization failed', { cause: error })
    }
  }

  /** 会话缓冲由保留轮次重放组成，保证压缩、裁剪与持久化使用同一份事实。 */
  private rebuildConversation(): void {
    const transcript = this.contextTurns.flatMap((turn) => [
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

  get currentReasoningEffort(): 'low' | 'medium' | 'high' | undefined {
    return this.reasoningEffort
  }

  get sessionTurnCount(): number {
    return this.totalTurnCount
  }

  get sessionMetrics(): Readonly<SessionCumulativeMetrics> {
    return this.cumulativeMetrics
  }

  /** 当前对话缓冲（不含下一条待发 prompt）；供 /context 展示上下文占用估算。 */
  get conversationMessages(): readonly ModelMessage[] {
    return this.conversation
  }

  get supportsFold(): boolean {
    return this.foldOptions !== undefined
  }

  /**
   * 结构化折叠事务（主计划 9.20）：冻结区间 → 无 Secret transcript → 确定性三层
   * 记忆 → 可选 LLM 增强 → 校验 → 投影落盘 → 切换 Model History；持久化失败回滚
   * 并继续使用旧历史。
   */
  async fold(trigger: FoldTrigger): Promise<number> {
    const fold = this.foldOptions
    if (!fold) {
      throw new Error('会话未配置结构化折叠')
    }
    const sessionId = this.persistence?.sessionId ?? 'session'
    const removed = Math.max(0, this.contextTurns.length - this.compactKeepTurns)
    if (removed === 0) {
      return 0
    }
    const foldedTurns = this.contextTurns.slice(0, removed)
    const previousNote = this.compactionNote
    const createdAt = new Date(this.clock()).toISOString()
    const folded = this.folder.fold({
      sessionId,
      trigger,
      turns: foldedTurns.map(toFoldTurnInput),
      sourceSequenceRange: foldSequenceRange(foldedTurns),
      redactor: fold.redactor,
    })
    let memory = folded.memory
    let degraded = true
    if (fold.summarize) {
      try {
        const draft = FoldSummaryDraftSchema.parse(
          await fold.summarize({ memory, transcriptTurns: folded.transcript.turns.length }),
        )
        const enhanced = applyFoldSummaryDraft(memory, draft)
        const check = validateFold(enhanced, {
          firstPrompt: foldedTurns[0]?.prompt ?? '',
          lastPrompt: foldedTurns.at(-1)?.prompt ?? '',
          failedToolResultCount: countFailedToolResults(folded.transcript.turns),
          unresolvedToolCallCount: folded.transcript.unresolvedToolCalls.length,
        })
        if (check.ok) {
          memory = FoldedSessionMemorySchema.parse(enhanced)
          degraded = false
        }
      } catch {
        // EX-10/11：摘要失败或非法输出 → degraded=true 确定性回退。
        memory = folded.memory
        degraded = true
      }
    }
    await fold.store.save(sessionId, {
      schemaVersion: 1,
      createdAt,
      degraded,
      memory,
    })
    this.compactionNote = renderFoldNote(memory, degraded)
    this.contextTurns.splice(0, removed)
    this.rebuildConversation()
    await this.persist()
    if (this.lastPersistError) {
      this.contextTurns.unshift(...foldedTurns)
      this.compactionNote = previousNote
      this.rebuildConversation()
      await fold.store.clear(sessionId).catch(() => undefined)
      await this.emitFoldEvent({ ok: false, degraded: true, trigger, removedTurns: 0 })
      throw new Error(`Conversation fold was not saved: ${this.lastPersistError}`)
    }
    await this.emitFoldEvent({ ok: true, degraded, trigger, removedTurns: removed })
    return removed
  }

  /** submit 前的自动折叠触发：context.utilization 阈值（复用 M0 信号）或熔断信号。 */
  private async beforeTurnHousekeeping(): Promise<void> {
    if (!this.foldOptions) {
      if (conversationChars(this.conversation) > this.maxConversationChars) {
        await this.compactHistory(this.compactKeepTurns)
      }
      return
    }
    const trigger = this.foldTriggerSignal()
    if (!trigger) {
      return
    }
    try {
      await this.fold(trigger)
    } catch {
      // 自动触发失败不阻塞本轮任务：继续使用旧历史（主计划 9.20 事务回退语义）。
      await this.emitFoldEvent({ ok: false, degraded: true, trigger, removedTurns: 0 })
    }
  }

  private foldTriggerSignal(): FoldTrigger | undefined {
    const fold = this.foldOptions
    if (!fold) {
      return undefined
    }
    const policy = fold.policy ?? DEFAULT_CONTEXT_BUDGET_POLICY
    const utilization = computeUtilization(
      this.conversation,
      resolveModelProfile(fold.profile),
      policy,
    )
    if (utilization.ratio >= policy.utilizationThreshold) {
      return 'auto'
    }
    if (this.contextTurns.at(-1)?.result.stopReason === 'repeatedToolCall') {
      return 'tool'
    }
    return undefined
  }

  private async emitFoldEvent(data: {
    ok: boolean
    degraded: boolean
    trigger: FoldTrigger
    removedTurns: number
  }): Promise<void> {
    const sink = this.foldOptions?.eventSink
    if (!sink) {
      return
    }
    try {
      await sink.emit('context', 'context.compacted', data)
    } catch {
      // 事件失败不影响折叠事务本身。
    }
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
      await this.beforeTurnHousekeeping()
      const startedAt = this.clock()
      const turn = this.nextTurn
      this.nextTurn += 1
      const turnId = `${this.persistence?.sessionId ?? 'memory'}:${turn}`
      if (this.persistence) {
        await this.persist()
        if (!this.lastPersistError) {
          try {
            await this.persistence.store.startTurn(
              this.persistence.sessionId,
              turnId,
              value,
              startedAt,
            )
          } catch (error) {
            this.lastPersistError = error instanceof Error ? error.message : String(error)
          }
        }
      }
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
          reasoningEffort: this.reasoningEffort,
        })
        // 保留本轮的完整消息轨迹（含工具调用与结果），下一轮原样重放给模型。
        this.conversation.push({ role: 'user', content: value })
        this.conversation.push(...transcriptOf({ result }))
        const entry = {
          turnId,
          prompt: value,
          result,
          startedAt,
          completedAt: this.clock(),
          activities,
        }
        this.turns.push(entry)
        this.contextTurns.push(entry)
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
    this.contextTurns.splice(
      0,
      this.contextTurns.length,
      ...(snapshot.contextTurns ?? snapshot.turns),
    )
    this.conversation = [...snapshot.conversation]
    this.nextTurn = Math.max(1, snapshot.nextTurn)
    this.planMode = snapshot.planMode
    this.persona = snapshot.persona.slice(0, MAX_PERSONA_CHARS)
    this.activeSkill = snapshot.activeSkill
    this.permissionMode = snapshot.permissionMode ?? this.permissionMode
    this.providerName = snapshot.provider ?? this.providerName
    this.modelName = snapshot.model ?? this.modelName
    this.reasoningEffort = snapshot.reasoningEffort ?? this.reasoningEffort
    this.compactionNote = snapshot.compactionNote ?? inferCompactionNote(snapshot.conversation)
    this.title = snapshot.title ?? snapshot.turns[0]?.prompt
    this.createdAt = snapshot.createdAt
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
      reasoningEffort: this.reasoningEffort,
      compactionNote: this.compactionNote,
      title: this.title,
      createdAt: (this.createdAt ??= new Date(this.clock()).toISOString()),
      preview: this.preview,
      totalTurnCount: this.totalTurnCount,
      cumulativeMetrics: { ...this.cumulativeMetrics },
      conversation: [...this.conversation],
      turns: [...this.turns],
      contextTurns: [...this.contextTurns],
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

function toFoldTurnInput(turn: SessionTurn): {
  turnId?: string
  prompt: string
  status: string
  stopReason?: string
  finalResponse: string
  turnTranscript?: ModelMessage[]
} {
  return {
    ...(turn.turnId ? { turnId: turn.turnId } : {}),
    prompt: turn.prompt,
    status: turn.result.status,
    ...(turn.result.stopReason ? { stopReason: turn.result.stopReason } : {}),
    finalResponse: turn.result.finalResponse,
    ...(turn.result.turnTranscript ? { turnTranscript: turn.result.turnTranscript } : {}),
  }
}

/** 轮次编号取自 turnId 的 `:N` 后缀；无法解析时退化为区间长度。 */
function foldSequenceRange(foldedTurns: readonly SessionTurn[]): {
  from: number
  to: number
} {
  const numbers = foldedTurns.map((turn) => {
    const match = turn.turnId?.match(/:(\d+)$/u)
    return match ? Number(match[1]) : undefined
  })
  if (numbers.every((value): value is number => typeof value === 'number')) {
    return { from: Math.min(...numbers), to: Math.max(...numbers) }
  }
  return { from: 0, to: Math.max(0, foldedTurns.length - 1) }
}

/** LLM 增强只填充叙述性字段；锚点（首/末 prompt）保持原值，保证 FoldValidator 仍可校验。 */
function applyFoldSummaryDraft(
  memory: FoldedSessionMemory,
  draft: FoldSummaryDraft,
): FoldedSessionMemory {
  return {
    ...memory,
    episodeMemory: {
      ...memory.episodeMemory,
      ...(draft.currentProgress ? { currentProgress: draft.currentProgress } : {}),
    },
    workingMemory: {
      ...memory.workingMemory,
      ...(draft.currentChallenges ? { currentChallenges: draft.currentChallenges } : {}),
      ...(draft.nextActions
        ? { nextActions: draft.nextActions.map((description) => ({ description })) }
        : {}),
    },
    toolMemory: {
      ...memory.toolMemory,
      ...(draft.derivedRules ? { derivedRules: draft.derivedRules } : {}),
    },
  }
}
