import type { Clock } from '@codeden/core/clock.js'
import type { AgentPort } from './agent/agent-contracts.js'
import {
  createSecurityServices,
  type SecurityServices,
} from '@codeden/core/security/security-services.js'
import { AgentRunner, type AgentRunnerDeps } from './agent/agent-runner.js'
import type { ModelProvider } from './models/model-provider.js'
import type { DocsNetworkPolicy } from './network/docs-network-policy.js'
import type { DocsSearchProvider } from './research/docs-search-provider.js'
import { FetchUrlTool } from './tools/builtins/fetch-url.js'
import { SearchDocsTool } from './tools/builtins/search-docs.js'
import { EditFileTool } from './tools/builtins/edit-file.js'
import { ReadFileTool } from './tools/builtins/read-file.js'
import { ListFilesTool } from './tools/builtins/list-files.js'
import { SearchFilesTool } from './tools/builtins/search-files.js'
import { RunCommandTool } from './tools/builtins/run-command.js'
import { RunPythonTool } from './tools/builtins/run-python.js'
import { ApplyPatchTool } from './tools/builtins/apply-patch.js'
import { StartCommandTool } from './tools/builtins/start-command.js'
import { GetCommandOutputTool } from './tools/builtins/get-command-output.js'
import { KillCommandTool } from './tools/builtins/kill-command.js'
import { GetDiagnosticsTool } from './tools/builtins/get-diagnostics.js'
import { GitStatusTool } from './tools/builtins/git-status.js'
import { GitDiffTool } from './tools/builtins/git-diff.js'
import { DeleteFileTool } from './tools/builtins/delete-file.js'
import { MoveFileTool } from './tools/builtins/move-file.js'
import { TodoWriteTool } from './tools/builtins/todo-write.js'
import { AskUserTool } from './tools/builtins/ask-user.js'
import { WebSearchTool } from './tools/builtins/web-search.js'
import { WebFetchTool } from './tools/builtins/web-fetch.js'
import { RepoMapTool } from './tools/builtins/repo-map.js'
import { FindSymbolTool } from './tools/builtins/find-symbol.js'
import { FindReferencesTool } from './tools/builtins/find-references.js'
import { ReadManyFilesTool } from './tools/builtins/read-many-files.js'
import { BackgroundTaskManager } from './tools/background-task-manager.js'
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
  backgroundTasks: BackgroundTaskManager = new BackgroundTaskManager(),
): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new ReadFileTool())
  registry.register(new ListFilesTool())
  registry.register(new SearchFilesTool())
  registry.register(new WriteFileTool())
  registry.register(new EditFileTool())
  registry.register(new RunCommandTool(commandOptions))
  registry.register(new RunPythonTool(commandOptions))
  registry.register(new ApplyPatchTool())
  registry.register(new StartCommandTool(backgroundTasks))
  registry.register(new GetCommandOutputTool(backgroundTasks))
  registry.register(new KillCommandTool(backgroundTasks))
  registry.register(new GetDiagnosticsTool(commandOptions))
  registry.register(new GitStatusTool())
  registry.register(new GitDiffTool())
  registry.register(new DeleteFileTool())
  registry.register(new MoveFileTool())
  registry.register(new TodoWriteTool())
  registry.register(new AskUserTool())
  registry.register(new WebSearchTool())
  registry.register(new WebFetchTool())
  registry.register(new RepoMapTool())
  registry.register(new FindSymbolTool())
  registry.register(new FindReferencesTool())
  registry.register(new ReadManyFilesTool())
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
  backgroundTasks: BackgroundTaskManager = new BackgroundTaskManager(),
): AgentRunnerDeps {
  const registry = createDefaultToolRegistry(
    docsNetworkPolicy,
    docsSearchProvider,
    commandOptions,
    additionalTools,
    backgroundTasks,
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
          allowedPaths: context.allowedPaths,
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
          approvalMode: context.approvalMode,
          security: {
            redactor: security.redactor,
            guard: security.guard,
            paths: security.paths,
          },
          subagentDepth: context.subagentDepth,
          includeUserInstructions: context.includeUserInstructions,
          confirmTool: context.confirmTool,
          askUser: context.askUser,
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
  backgroundTasks: BackgroundTaskManager = new BackgroundTaskManager(),
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
    backgroundTasks,
  )
  const agent = new AgentRunner(deps)
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
  backgroundTasks: BackgroundTaskManager = new BackgroundTaskManager(),
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
    backgroundTasks,
  )
  const runner = new AgentRunner(deps)
  deps.registry.register(new SubagentTool(runner))
  return runner
}
