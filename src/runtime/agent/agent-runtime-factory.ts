import type { SecurityServices } from '../../security/security-services.js'
import { createCodeDenAgent } from '../create-codeden-runtime.js'
import type { ModelProvider } from '../models/model-provider.js'
import type { DocsNetworkPolicy } from '../network/docs-network-policy.js'
import type { DocsSearchProvider } from '../research/docs-search-provider.js'
import type { CompletionVerifier } from '../verification/completion-verifier.js'
import type { RunCommandOptions } from '../tools/builtins/run-command.js'
import type { AgentPort } from '../../eval/ports/agent.port.js'

export interface AgentRuntimeFactoryOptions {
  provider: ModelProvider
  security: SecurityServices
  verifier?: CompletionVerifier
  docsNetworkPolicy?: DocsNetworkPolicy
  docsSearchProvider?: DocsSearchProvider
  commandOptions?: RunCommandOptions
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
    )
  }
}
