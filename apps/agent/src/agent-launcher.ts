import type { CodeDenConfig } from '@codeden/core/config/config-schema.js'
import type { AgentRunResult } from '@codeden/agent-runtime/agent/agent-contracts.js'
import { SecureEventSink } from '@codeden/core/security/secure-event-sink.js'
import { BestEffortEventSink, CompositeEventSink } from '@codeden/core/events/event-sink.js'
import type { SecurityServices } from '@codeden/core/security/security-services.js'
import { AgentRuntimeFactory } from '@codeden/agent-runtime/agent/agent-runtime-factory.js'
import type { ModelProvider } from '@codeden/agent-runtime/models/model-provider.js'
import { ProjectInspector } from '@codeden/agent-runtime/project/project-inspector.js'
import { buildTaskSpec } from '@codeden/agent-runtime/task/task-spec-builder.js'
import { captureBaseline } from '@codeden/agent-runtime/verification/baseline-recorder.js'
import type { BaselineSnapshot } from '@codeden/agent-runtime/verification/baseline-snapshot.js'
import { DefaultCompletionVerifier } from '@codeden/agent-runtime/verification/completion-verifier.js'
import type { CompletionCheck } from '@codeden/agent-runtime/verification/verification-result.js'
import {
  GitWorktreeSession,
  type ApplyResult,
} from '@codeden/agent-runtime/workspace/git-worktree-session.js'
import { CaptureVerificationSink } from './capture-verification-sink.js'
import { MemoryStore } from '@codeden/agent-runtime/memory/memory-store.js'
import { SkillLoader } from '@codeden/agent-runtime/skills/skill-loader.js'
import { McpManager } from '@codeden/agent-runtime/mcp/mcp-manager.js'
import { RevisionBoundCompletionVerifier } from '@codeden/agent-runtime/attempts/verified-workspace-snapshot.js'
import { createTraceCaptureSink } from '@codeden/telemetry/trace-capture-factory.js'
import { createRunIdentifiers } from '@codeden/core/ids.js'

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
  const identifiers = createRunIdentifiers()
  const taskSpec = buildTaskSpec(input.prompt, facts)
  const baseline = await captureBaseline(taskSpec, input.session.workspace)
  const capture = new CaptureVerificationSink()
  const traceCapture = await createTraceCaptureSink({
    projectRoot: input.session.originRoot,
    runId: identifiers.runId,
    trialId: identifiers.trialId,
    security: input.security,
    telemetry: input.config.telemetry,
  })
  const eventSink = new SecureEventSink(
    new CompositeEventSink([capture, new BestEffortEventSink(traceCapture)]),
    input.security.redactor,
    input.security.guard,
  )
  const memory = await new MemoryStore({ projectRoot: input.session.originRoot }).list()
  const skills = await new SkillLoader({ projectRoot: input.session.originRoot }).discover()
  const mcpManager = new McpManager(input.config.mcp.servers, input.security.resolver)
  const mcpTools =
    Object.keys(input.config.mcp.servers).length > 0 ? await mcpManager.connectAll() : []
  const completionVerifier = new RevisionBoundCompletionVerifier(
    new DefaultCompletionVerifier(baseline),
    { attemptId: identifiers.runId, baseCommit: input.session.baseRevision },
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
        runId: identifiers.runId,
        trialId: identifiers.trialId,
        workspace: input.session.workspace,
        eventSink,
        limits: {
          maxTurns: input.config.agent.maxTurns,
          maxToolCalls: input.config.agent.maxToolCalls,
        },
        submissionType: 'files',
        allowedPaths: taskSpec.allowedPaths,
        approvalMode: 'auto',
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
