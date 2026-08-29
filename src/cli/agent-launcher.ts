import type { CodeDenConfig } from '../config/config-schema.js'
import type { AgentRunResult } from '../eval/ports/agent.port.js'
import { SecureEventSink } from '../security/secure-event-sink.js'
import type { SecurityServices } from '../security/security-services.js'
import { AgentRuntimeFactory } from '../runtime/agent/agent-runtime-factory.js'
import type { ModelProvider } from '../runtime/models/model-provider.js'
import { ProjectInspector } from '../runtime/project/project-inspector.js'
import { buildTaskSpec } from '../runtime/task/task-spec-builder.js'
import { captureBaseline } from '../runtime/verification/baseline-recorder.js'
import type { BaselineSnapshot } from '../runtime/verification/baseline-snapshot.js'
import { DefaultCompletionVerifier } from '../runtime/verification/completion-verifier.js'
import type { CompletionCheck } from '../runtime/verification/verification-result.js'
import { GitWorktreeSession, type ApplyResult } from '../runtime/workspace/git-worktree-session.js'
import { CaptureVerificationSink } from './capture-verification-sink.js'
import { MemoryStore } from '../runtime/memory/memory-store.js'
import { SkillLoader } from '../runtime/skills/skill-loader.js'
import { McpManager } from '../runtime/mcp/mcp-manager.js'
import { RevisionBoundCompletionVerifier } from '../runtime/attempts/verified-workspace-snapshot.js'

export interface AgentLaunchExecution {
  result: AgentRunResult
  baseline?: BaselineSnapshot
  lastCheck?: CompletionCheck
  apply?: ApplyResult
}

export async function runAgentInSession(input: {
  prompt: string
  config: CodeDenConfig
  provider: ModelProvider
  session: GitWorktreeSession
  security: SecurityServices
}): Promise<AgentLaunchExecution> {
  const facts = await new ProjectInspector().inspect(input.session.originRoot)
  const taskSpec = buildTaskSpec(input.prompt, facts)
  const baseline = await captureBaseline(taskSpec, input.session.workspace)
  const capture = new CaptureVerificationSink()
  const eventSink = new SecureEventSink(capture, input.security.redactor, input.security.guard)
  const memory = await new MemoryStore({ projectRoot: input.session.originRoot }).list()
  const skills = await new SkillLoader({ projectRoot: input.session.originRoot }).discover()
  const mcpManager = new McpManager(input.config.mcp.servers, input.security.resolver)
  const mcpTools =
    Object.keys(input.config.mcp.servers).length > 0 ? await mcpManager.connectAll() : []
  const completionVerifier = new RevisionBoundCompletionVerifier(
    new DefaultCompletionVerifier(baseline),
    { attemptId: 'cli', baseCommit: input.session.baseRevision },
  )
  const agent = new AgentRuntimeFactory().createFromConfig({
    config: input.config,
    provider: input.provider,
    security: input.security,
    verifier: completionVerifier,
    additionalTools: mcpTools,
  })
  try {
    const result = await agent.run(
      { prompt: input.prompt, taskSpec },
      {
        runId: 'cli',
        trialId: 'cli',
        workspace: input.session.workspace,
        eventSink,
        limits: {
          maxTurns: input.config.agent.maxTurns,
          maxToolCalls: input.config.agent.maxToolCalls,
        },
        submissionType: 'files',
        allowedPaths: taskSpec.allowedPaths,
        memory,
        skills,
      },
    )
    let apply: ApplyResult | undefined
    if (
      result.status === 'verified_complete' &&
      result.submission?.type === 'files' &&
      result.verifiedSnapshot
    ) {
      apply = await input.session.applyVerifiedSnapshot(result.verifiedSnapshot)
    }
    return { result, baseline, lastCheck: capture.lastCheck, apply }
  } finally {
    await mcpManager.close()
  }
}
