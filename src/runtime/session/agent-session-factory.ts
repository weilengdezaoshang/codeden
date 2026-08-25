import type { AgentPort, AgentRunContext, AgentTask } from '../../eval/ports/agent.port.js'
import { AgentSession } from './agent-session.js'

export interface AgentSessionFactoryOptions {
  agent: AgentPort
  context: (prompt: string, turn: number) => AgentRunContext
  task: (prompt: string, turn: number) => AgentTask
}

/** Centralizes session construction so CLI entrypoints share the same lifecycle boundary. */
export class AgentSessionFactory {
  create(options: AgentSessionFactoryOptions): AgentSession {
    return new AgentSession(options.agent, options.context, options.task)
  }
}
