import { ConfigLoader } from '../config/config-loader.js'
import type { CodeDenConfig } from '../config/config-schema.js'
import type { EventSink } from '../core/events/event-sink.js'
import type { RunEventSource } from '../core/events/run-event.js'
import type { AgentRunResult } from '../eval/ports/agent.port.js'
import { SecureEventSink } from '../security/secure-event-sink.js'
import { createSecurityServices, type SecurityServices } from '../security/security-services.js'
import { TemporaryWorkspaceAdapter } from '../eval/adapters/workspaces/temporary-workspace.adapter.js'
import { createCodeDenAgent } from '../runtime/create-codeden-runtime.js'
import { ModelProviderFactory } from '../runtime/models/model-provider-factory.js'
import type { ModelProvider } from '../runtime/models/model-provider.js'
import { ProviderRegistry } from '../runtime/models/provider-registry.js'
import { ProjectInspector } from '../runtime/project/project-inspector.js'
import { buildTaskSpec } from '../runtime/task/task-spec-builder.js'
import { captureBaseline } from '../runtime/verification/baseline-recorder.js'
import type { BaselineSnapshot } from '../runtime/verification/baseline-snapshot.js'
import { DefaultCompletionVerifier } from '../runtime/verification/completion-verifier.js'
import type { CompletionCheck } from '../runtime/verification/verification-result.js'

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
    const facts = await new ProjectInspector().inspect(options.workspaceRoot)
    const taskSpec = buildTaskSpec(options.prompt, facts)
    const workspace = await TemporaryWorkspaceAdapter.fromExisting(options.workspaceRoot, {
      deleteOnDispose: false,
    })
    const baseline = await captureBaseline(taskSpec, workspace)
    const capture = new CaptureVerificationSink()
    const eventSink = new SecureEventSink(capture, this.security.redactor, this.security.guard)
    const agent = createCodeDenAgent(
      provider,
      undefined,
      this.security,
      new DefaultCompletionVerifier(baseline),
    )
    const result = await agent.run(
      {
        prompt: options.prompt,
        taskSpec,
      },
      {
        runId: 'cli',
        trialId: 'cli',
        workspace,
        eventSink,
        limits: {
          maxTurns: config.agent.maxTurns,
          maxToolCalls: config.agent.maxToolCalls,
        },
        submissionType: 'files',
        allowedPaths: taskSpec.allowedPaths,
      },
    )
    return { result, baseline, lastCheck: capture.lastCheck }
  }
}

class CaptureVerificationSink implements EventSink {
  lastCheck: CompletionCheck | undefined

  async emit(source: RunEventSource, type: string, data?: unknown): Promise<void> {
    void source
    if (
      (type === 'verification.failed' || type === 'verification.completed') &&
      data &&
      typeof data === 'object' &&
      'passed' in data
    ) {
      this.lastCheck = data as CompletionCheck
    }
  }
}
