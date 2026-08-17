import type {
  AgentPort,
  AgentRunContext,
  AgentRunResult,
  AgentTask,
} from '../../ports/agent.port.js'
import { AgentRunner, type AgentRunnerDeps } from '../../../runtime/agent/agent-runner.js'

export class CodeDenAgentAdapter implements AgentPort {
  readonly name: string
  private readonly runner: AgentRunner

  constructor(deps: AgentRunnerDeps & { name?: string }) {
    this.runner = new AgentRunner(deps)
    this.name = deps.name ?? `codeden/${deps.model.name}`
  }

  run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult> {
    return this.runner.run(task, context)
  }
}
