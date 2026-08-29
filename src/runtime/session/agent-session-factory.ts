import type { AgentPort, AgentRunContext, AgentTask } from '../../eval/ports/agent.port.js'
import { AgentSession, type AgentSessionOptions } from './agent-session.js'
import type { SessionStore } from './session-store.js'

export interface AgentSessionFactoryOptions {
  agent: AgentPort
  context: (
    prompt: string,
    turn: number,
    task: AgentTask,
  ) => AgentRunContext | Promise<AgentRunContext>
  task: (prompt: string, turn: number) => AgentTask | Promise<AgentTask>
  persistence?: { store: SessionStore; sessionId: string }
  sessionOptions?: AgentSessionOptions
}

/** Centralizes session construction so CLI entrypoints share the same lifecycle boundary. */
export class AgentSessionFactory {
  create(options: AgentSessionFactoryOptions): AgentSession {
    return new AgentSession(
      options.agent,
      options.context,
      options.task,
      Date.now,
      options.persistence,
      options.sessionOptions,
    )
  }
}
