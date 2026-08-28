import type { AgentPort, AgentRunContext, AgentRunResult } from '../../eval/ports/agent.port.js'
import type { AgentTask } from '../../eval/ports/agent.port.js'
import type { ModelMessage } from '../models/model-types.js'
import { MAX_PERSONA_CHARS } from '../prompt/prompt-composer.js'
import type { SessionSnapshot, SessionStore } from './session-store.js'

export interface SessionTurn {
  readonly prompt: string
  readonly result: AgentRunResult
  readonly startedAt: number
  readonly completedAt: number
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

  constructor(
    private readonly agent: AgentPort,
    private readonly createContext: (prompt: string, turn: number) => AgentRunContext,
    private readonly createTask: (prompt: string, turn: number) => AgentTask,
    private readonly clock: () => number = Date.now,
    private readonly persistence?: { store: SessionStore; sessionId: string },
  ) {}

  get history(): readonly SessionTurn[] {
    return this.turns
  }

  async resume(): Promise<boolean> {
    if (!this.persistence) {
      return false
    }
    const snapshot = await this.persistence.store.load(this.persistence.sessionId)
    if (!snapshot) {
      return false
    }
    if (this.turns.length > 0 || this.conversation.length > 0) {
      throw new Error('Cannot resume a session after it has started')
    }
    this.restore(snapshot)
    return true
  }

  clearHistory(): void {
    this.turns.length = 0
    this.conversation = []
    void this.persist().catch(() => undefined)
  }

  compactHistory(keepTurns = 4): number {
    const keep = Math.max(0, Math.floor(keepTurns))
    const removed = Math.max(0, this.turns.length - keep)
    if (removed === 0) {
      return 0
    }
    this.turns.splice(0, removed)
    this.conversation = [
      {
        role: 'system',
        content: `Earlier conversation was compacted; ${removed} turn(s) were removed. Continue from the current workspace state.`,
      },
      ...this.conversation.slice(removed * 2),
    ]
    void this.persist().catch(() => undefined)
    return removed
  }

  togglePlanMode(): boolean {
    this.planMode = !this.planMode
    void this.persist().catch(() => undefined)
    return this.planMode
  }

  get isPlanMode(): boolean {
    return this.planMode
  }

  setPersona(persona: string): void {
    this.persona = persona.trim().slice(0, MAX_PERSONA_CHARS)
    void this.persist().catch(() => undefined)
  }

  get currentPersona(): string {
    return this.persona
  }

  setActiveSkill(name: string): void {
    this.activeSkill = name.trim()
    void this.persist().catch(() => undefined)
  }

  get currentSkill(): string {
    return this.activeSkill
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
      const startedAt = this.clock()
      const turn = this.nextTurn
      this.nextTurn += 1
      const result = await this.agent.run(this.createTask(value, turn), {
        ...this.createContext(value, turn),
        conversation: [...this.conversation],
        readOnly: this.planMode,
        persona: this.persona,
      })
      this.conversation.push({ role: 'user', content: value })
      this.conversation.push({ role: 'assistant', content: result.finalResponse })
      const entry = { prompt: value, result, startedAt, completedAt: this.clock() }
      this.turns.push(entry)
      await this.persist()
      return entry
    })
    this.pending = run.then(
      () => undefined,
      () => undefined,
    )
    return run
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
  }

  private async persist(): Promise<void> {
    if (!this.persistence) {
      return
    }
    await this.persistence.store.save({
      schemaVersion: 1,
      sessionId: this.persistence.sessionId,
      nextTurn: this.nextTurn,
      planMode: this.planMode,
      persona: this.persona,
      activeSkill: this.activeSkill,
      conversation: [...this.conversation],
      turns: [...this.turns],
      updatedAt: new Date(this.clock()).toISOString(),
    })
  }
}
