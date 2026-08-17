import type { Clock } from '../core/clock.js'
import { CodeDenAgentAdapter } from '../eval/adapters/agents/codeden-agent.adapter.js'
import type { AgentPort } from '../eval/ports/agent.port.js'
import { AgentRunner, type AgentRunnerDeps } from './agent/agent-runner.js'
import type { ModelProvider } from './models/model-provider.js'
import { EditFileTool } from './tools/builtins/edit-file.js'
import { ReadFileTool } from './tools/builtins/read-file.js'
import { RunCommandTool } from './tools/builtins/run-command.js'
import { WriteFileTool } from './tools/builtins/write-file.js'
import { ToolExecutor } from './tools/tool-executor.js'
import { ToolRegistry } from './tools/tool-registry.js'
import { WorkspacePolicy } from './workspace/workspace-policy.js'

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new ReadFileTool())
  registry.register(new WriteFileTool())
  registry.register(new EditFileTool())
  registry.register(new RunCommandTool())
  return registry
}

export function createAgentDeps(model: ModelProvider, clock?: Clock): AgentRunnerDeps {
  const registry = createDefaultToolRegistry()
  return {
    model,
    registry,
    clock,
    createExecutor: (context) =>
      new ToolExecutor({
        registry,
        budget: { maxToolCalls: context.limits.maxToolCalls, used: 0 },
        eventSink: context.eventSink,
        clock,
        context: {
          workspaceRoot: context.workspace.root,
          policy: new WorkspacePolicy(context.workspace.root, {
            readableRoots: ['.'],
            writableRoots:
              context.allowedPaths && context.allowedPaths.length > 0
                ? context.allowedPaths
                : ['.'],
            allowCommands: true,
          }),
          eventSink: context.eventSink,
          abortSignal: context.abortSignal,
        },
      }),
  }
}

export function createCodeDenAgent(model: ModelProvider, clock?: Clock): AgentPort {
  return new CodeDenAgentAdapter(createAgentDeps(model, clock))
}

export function createAgentRunner(model: ModelProvider, clock?: Clock): AgentRunner {
  return new AgentRunner(createAgentDeps(model, clock))
}
