import type { Clock } from '../core/clock.js'
import { CodeDenAgentAdapter } from '../eval/adapters/agents/codeden-agent.adapter.js'
import type { AgentPort } from '../eval/ports/agent.port.js'
import { createSecurityServices, type SecurityServices } from '../security/security-services.js'
import { AgentRunner, type AgentRunnerDeps } from './agent/agent-runner.js'
import type { ModelProvider } from './models/model-provider.js'
import type { DocsNetworkPolicy } from './network/docs-network-policy.js'
import { FetchUrlTool } from './tools/builtins/fetch-url.js'
import { EditFileTool } from './tools/builtins/edit-file.js'
import { ReadFileTool } from './tools/builtins/read-file.js'
import { RunCommandTool } from './tools/builtins/run-command.js'
import { WriteFileTool } from './tools/builtins/write-file.js'
import { ToolExecutor } from './tools/tool-executor.js'
import { ToolRegistry } from './tools/tool-registry.js'
import type { CompletionVerifier } from './verification/completion-verifier.js'
import { WorkspacePolicy } from './workspace/workspace-policy.js'

export function createDefaultToolRegistry(docsNetworkPolicy?: DocsNetworkPolicy): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new ReadFileTool())
  registry.register(new WriteFileTool())
  registry.register(new EditFileTool())
  registry.register(new RunCommandTool())
  if (docsNetworkPolicy) {
    registry.register(new FetchUrlTool(docsNetworkPolicy))
  }
  return registry
}

export function createAgentDeps(
  model: ModelProvider,
  clock?: Clock,
  security: SecurityServices = createSecurityServices(),
  verifier?: CompletionVerifier,
  docsNetworkPolicy?: DocsNetworkPolicy,
): AgentRunnerDeps {
  const registry = createDefaultToolRegistry(docsNetworkPolicy)
  return {
    model,
    registry,
    clock,
    verifier,
    redactor: security.redactor,
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
          security: {
            redactor: security.redactor,
            guard: security.guard,
            paths: security.paths,
          },
        },
      }),
  }
}

export function createCodeDenAgent(
  model: ModelProvider,
  clock?: Clock,
  security?: SecurityServices,
  verifier?: CompletionVerifier,
  docsNetworkPolicy?: DocsNetworkPolicy,
): AgentPort {
  return new CodeDenAgentAdapter(
    createAgentDeps(model, clock, security, verifier, docsNetworkPolicy),
  )
}

export function createAgentRunner(
  model: ModelProvider,
  clock?: Clock,
  security?: SecurityServices,
  verifier?: CompletionVerifier,
  docsNetworkPolicy?: DocsNetworkPolicy,
): AgentRunner {
  return new AgentRunner(createAgentDeps(model, clock, security, verifier, docsNetworkPolicy))
}
