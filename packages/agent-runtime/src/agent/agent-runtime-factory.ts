import type { SecurityServices } from '@codeden/core/security/security-services.js'
import { createCodeDenAgent } from '../create-codeden-runtime.js'
import type { ModelProvider } from '../models/model-provider.js'
import type { DocsSearchProvider } from '../research/docs-search-provider.js'
import type { CompletionVerifier } from '../verification/completion-verifier.js'
import type { RunCommandOptions } from '../tools/builtins/run-command.js'
import type { AgentPort } from './agent-contracts.js'
import type { CodeDenConfig } from '@codeden/core/config/config-schema.js'
import { DuckDuckGoDocsSearchProvider } from '../research/duckduckgo-docs-search-provider.js'
import { DocsNetworkPolicy } from '../network/docs-network-policy.js'
import type { Tool } from '../tools/tool.js'
import type { BackgroundTaskManager } from '../tools/background-task-manager.js'
import type { SubagentSummaryMode } from '../context/subagent-summary.js'

export interface AgentRuntimeFactoryOptions {
  provider: ModelProvider
  /** Provider 在配置中的键名；未提供时回退到 provider.name。 */
  providerName?: string
  security: SecurityServices
  verifier?: CompletionVerifier
  docsNetworkPolicy?: DocsNetworkPolicy
  docsSearchProvider?: DocsSearchProvider
  commandOptions?: RunCommandOptions
  additionalTools?: Tool[]
  toolsEnabled?: boolean
  /** 由调用方持有以便在会话切换或退出时 killAll 的后台任务管理器。 */
  backgroundTasks?: BackgroundTaskManager
  /** 子 Agent 结果回传模式（M3/EX-14）；未提供时默认 summary。 */
  subagentSummaryMode?: SubagentSummaryMode
}

export class AgentRuntimeFactory {
  create(options: AgentRuntimeFactoryOptions): AgentPort {
    return createCodeDenAgent(
      options.provider,
      undefined,
      options.security,
      options.verifier,
      options.docsNetworkPolicy,
      options.docsSearchProvider,
      options.commandOptions,
      options.additionalTools,
      options.toolsEnabled,
      options.backgroundTasks,
      options.subagentSummaryMode,
    )
  }

  createFromConfig(
    options: Omit<
      AgentRuntimeFactoryOptions,
      'docsNetworkPolicy' | 'docsSearchProvider' | 'commandOptions'
    > & {
      config: CodeDenConfig
      additionalTools?: Tool[]
    },
  ): AgentPort {
    const docs = options.config.network.docs
    return this.create({
      provider: options.provider,
      security: options.security,
      verifier: options.verifier,
      docsNetworkPolicy: docs.enabled
        ? new DocsNetworkPolicy({ allowedDomains: docs.allowedDomains })
        : undefined,
      docsSearchProvider: docs.enabled ? new DuckDuckGoDocsSearchProvider() : undefined,
      commandOptions: options.config.network.commands,
      additionalTools: options.additionalTools,
      backgroundTasks: options.backgroundTasks,
      subagentSummaryMode: options.config.agent.subagent?.summaryMode,
      toolsEnabled:
        options.config.providers[options.providerName ?? options.provider.name]?.capabilities
          .tools ?? true,
    })
  }
}
