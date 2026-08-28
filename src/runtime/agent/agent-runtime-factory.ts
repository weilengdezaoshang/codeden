import type { SecurityServices } from '../../security/security-services.js'
import { createCodeDenAgent } from '../create-codeden-runtime.js'
import type { ModelProvider } from '../models/model-provider.js'
import type { DocsSearchProvider } from '../research/docs-search-provider.js'
import type { CompletionVerifier } from '../verification/completion-verifier.js'
import type { RunCommandOptions } from '../tools/builtins/run-command.js'
import type { AgentPort } from '../../eval/ports/agent.port.js'
import type { CodeDenConfig } from '../../config/config-schema.js'
import { DuckDuckGoDocsSearchProvider } from '../research/duckduckgo-docs-search-provider.js'
import { DocsNetworkPolicy } from '../network/docs-network-policy.js'
import type { Tool } from '../tools/tool.js'

export interface AgentRuntimeFactoryOptions {
  provider: ModelProvider
  security: SecurityServices
  verifier?: CompletionVerifier
  docsNetworkPolicy?: DocsNetworkPolicy
  docsSearchProvider?: DocsSearchProvider
  commandOptions?: RunCommandOptions
  additionalTools?: Tool[]
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
    })
  }
}
