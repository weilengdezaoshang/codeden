import type { Clock } from '../core/clock.js'
import { CodeDenAgentAdapter } from '../eval/adapters/agents/codeden-agent.adapter.js'
import type { AgentPort } from '../eval/ports/agent.port.js'
import { createSecurityServices, type SecurityServices } from '../security/security-services.js'
import { AgentRunner, type AgentRunnerDeps } from './agent/agent-runner.js'
import type { ModelProvider } from './models/model-provider.js'
import type { DocsNetworkPolicy } from './network/docs-network-policy.js'
import type { DocsSearchProvider } from './research/docs-search-provider.js'
import { FetchUrlTool } from './tools/builtins/fetch-url.js'
import { SearchDocsTool } from './tools/builtins/search-docs.js'
import { EditFileTool } from './tools/builtins/edit-file.js'
import { ReadFileTool } from './tools/builtins/read-file.js'
import { RunCommandTool } from './tools/builtins/run-command.js'
import type { RunCommandOptions } from './tools/builtins/run-command.js'
import { WriteFileTool } from './tools/builtins/write-file.js'
import { ToolExecutor } from './tools/tool-executor.js'
import { ToolRegistry } from './tools/tool-registry.js'
import type { CompletionVerifier } from './verification/completion-verifier.js'
import { WorkspacePolicy } from './workspace/workspace-policy.js'
import type { Tool } from './tools/tool.js'
import { SubagentTool } from './tools/builtins/subagent.js'

export function createDefaultToolRegistry(
  docsNetworkPolicy?: DocsNetworkPolicy,
  docsSearchProvider?: DocsSearchProvider,
  commandOptions?: RunCommandOptions,
  additionalTools: Tool[] = [],
): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new ReadFileTool())
  registry.register(new WriteFileTool())
  registry.register(new EditFileTool())
  registry.register(new RunCommandTool(commandOptions))
  if (docsNetworkPolicy) {
    registry.register(new FetchUrlTool(docsNetworkPolicy))
    if (docsSearchProvider) {
      registry.register(new SearchDocsTool(docsNetworkPolicy, docsSearchProvider))
    }
  }
  for (const tool of additionalTools) {
    registry.register(tool)
  }
  return registry
}

export function createAgentDeps(
  model: ModelProvider,
  clock?: Clock,
  security: SecurityServices = createSecurityServices(),
  verifier?: CompletionVerifier,
  docsNetworkPolicy?: DocsNetworkPolicy,
  docsSearchProvider?: DocsSearchProvider,
  commandOptions?: RunCommandOptions,
  additionalTools: Tool[] = [],
  toolsEnabled = true,
): AgentRunnerDeps {
  const registry = createDefaultToolRegistry(
    docsNetworkPolicy,
    docsSearchProvider,
    commandOptions,
    additionalTools,
  )
  return {
    model,
    registry,
    clock,
    verifier,
    toolsEnabled,
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
            writableRoots: context.readOnly
              ? []
              : context.allowedPaths && context.allowedPaths.length > 0
                ? context.allowedPaths
                : ['.'],
            allowCommands: !context.readOnly,
          }),
          eventSink: context.eventSink,
          abortSignal: context.abortSignal,
          security: {
            redactor: security.redactor,
            guard: security.guard,
            paths: security.paths,
          },
          subagentDepth: context.subagentDepth,
          confirmTool: context.confirmTool,
        },
        allowedTools: context.activeSkill
          ? context.skills?.find((skill) => skill.name === context.activeSkill)?.allowedTools
          : undefined,
      }),
  }
}

export function createCodeDenAgent(
  model: ModelProvider,
  clock?: Clock,
  security?: SecurityServices,
  verifier?: CompletionVerifier,
  docsNetworkPolicy?: DocsNetworkPolicy,
  docsSearchProvider?: DocsSearchProvider,
  commandOptions?: RunCommandOptions,
  additionalTools: Tool[] = [],
  toolsEnabled = true,
): AgentPort {
  const deps = createAgentDeps(
    model,
    clock,
    security,
    verifier,
    docsNetworkPolicy,
    docsSearchProvider,
    commandOptions,
    additionalTools,
    toolsEnabled,
  )
  const agent = new CodeDenAgentAdapter(deps)
  deps.registry.register(new SubagentTool(agent))
  return agent
}

export function createAgentRunner(
  model: ModelProvider,
  clock?: Clock,
  security?: SecurityServices,
  verifier?: CompletionVerifier,
  docsNetworkPolicy?: DocsNetworkPolicy,
  docsSearchProvider?: DocsSearchProvider,
  commandOptions?: RunCommandOptions,
  additionalTools: Tool[] = [],
  toolsEnabled = true,
): AgentRunner {
  const deps = createAgentDeps(
    model,
    clock,
    security,
    verifier,
    docsNetworkPolicy,
    docsSearchProvider,
    commandOptions,
    additionalTools,
    toolsEnabled,
  )
  const runner = new AgentRunner(deps)
  deps.registry.register(new SubagentTool(runner))
  return runner
}
