import { ConfigLoader } from '@codeden/core/config/config-loader.js'
import type { CodeDenConfig } from '@codeden/core/config/config-schema.js'
import type { AgentRunResult } from '@codeden/agent-runtime/agent/agent-contracts.js'
import { runAgentInSession } from './agent-launcher.js'
import {
  createSecurityServices,
  type SecurityServices,
} from '@codeden/core/security/security-services.js'
import { createModelProvider } from '@codeden/agent-runtime/models/create-model-provider.js'
import { ModelProviderFactory } from '@codeden/agent-runtime/models/model-provider-factory.js'
import type { ModelProvider } from '@codeden/agent-runtime/models/model-provider.js'
import { ProviderRegistry } from '@codeden/agent-runtime/models/provider-registry.js'
import type { BaselineSnapshot } from '@codeden/agent-runtime/verification/baseline-snapshot.js'
import type { CompletionCheck } from '@codeden/agent-runtime/verification/verification-result.js'
import {
  GitWorktreeSession,
  type ApplyResult,
} from '@codeden/agent-runtime/workspace/git-worktree-session.js'

export interface AgentLaunchOptions {
  workspaceRoot: string
  prompt: string
  providerName?: string
  modelName?: string
}

export interface AgentLaunchResult {
  result: AgentRunResult
  baseline?: BaselineSnapshot
  lastCheck?: CompletionCheck
  isolated: boolean
  worktreeRoot?: string
  apply?: ApplyResult
}

export class DependencyContainer {
  readonly security: SecurityServices
  private readonly loader = new ConfigLoader()

  constructor(security: SecurityServices = createSecurityServices()) {
    this.security = security
  }

  async loadConfig(workspaceRoot: string, extraSearchRoots: string[] = []): Promise<CodeDenConfig> {
    return this.loader.load(workspaceRoot, extraSearchRoots)
  }

  async resolveConfigPath(workspaceRoot: string, extraSearchRoots: string[] = []): Promise<string> {
    return this.loader.resolveConfigPath(workspaceRoot, extraSearchRoots)
  }

  createProvider(config: CodeDenConfig, providerName?: string, modelName?: string): ModelProvider {
    if (providerName === 'mock' || modelName === 'mock') {
      return createModelProvider('mock')
    }
    const factory = new ModelProviderFactory(this.security.resolver)
    return new ProviderRegistry(factory).createFromConfig(
      config,
      providerName ?? config.agent.defaultProvider,
      modelName ?? config.agent.defaultModel,
    )
  }

  async runAgent(options: AgentLaunchOptions): Promise<AgentLaunchResult> {
    const config = await this.loadConfig(options.workspaceRoot, [process.cwd()])
    const provider = this.createProvider(config, options.providerName, options.modelName)
    const session = await GitWorktreeSession.open(
      options.workspaceRoot,
      this.security,
      config.network.commands,
    )
    let wrotePatch = false
    try {
      const execution = await runAgentInSession({
        prompt: options.prompt,
        config,
        provider,
        session,
        security: this.security,
      })
      wrotePatch = execution.apply !== undefined
      return {
        result: execution.result,
        baseline: execution.baseline,
        lastCheck: execution.lastCheck,
        isolated: session.isolated,
        worktreeRoot: session.worktreeRoot,
        apply: execution.apply,
      }
    } finally {
      if (!wrotePatch) {
        await session.discardPatch()
      }
      await session.dispose()
    }
  }
}
