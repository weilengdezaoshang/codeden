import type { AgentPort, AgentRunContext, AgentRunResult } from '../../eval/ports/agent.port.js'
import type { AgentTask } from '../../eval/ports/agent.port.js'
import type { ModelMessage } from '../models/model-types.js'

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

  constructor(
    private readonly agent: AgentPort,
    private readonly createContext: (prompt: string, turn: number) => AgentRunContext,
    private readonly createTask: (prompt: string, turn: number) => AgentTask,
    private readonly clock: () => number = Date.now,
  ) {}

  get history(): readonly SessionTurn[] {
    return this.turns
  }

  clearHistory(): void {
    this.turns.length = 0
    this.conversation = []
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
      const turn = this.turns.length + 1
      const result = await this.agent.run(this.createTask(value, turn), {
        ...this.createContext(value, turn),
        conversation: [...this.conversation],
      })
      this.conversation.push({ role: 'user', content: value })
      if (result.finalResponse) {
        this.conversation.push({ role: 'assistant', content: result.finalResponse })
      }
      const entry = { prompt: value, result, startedAt, completedAt: this.clock() }
      this.turns.push(entry)
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
}
