import type { CodeDenConfig } from '../config/config-schema.js'
import type { AgentRunResult } from '../eval/ports/agent.port.js'
import { SecureEventSink } from '../security/secure-event-sink.js'
import type { SecurityServices } from '../security/security-services.js'
import { createCodeDenAgent } from '../runtime/create-codeden-runtime.js'
import type { ModelProvider } from '../runtime/models/model-provider.js'
import { ProjectInspector } from '../runtime/project/project-inspector.js'
import { buildTaskSpec } from '../runtime/task/task-spec-builder.js'
import { captureBaseline } from '../runtime/verification/baseline-recorder.js'
import type { BaselineSnapshot } from '../runtime/verification/baseline-snapshot.js'
import { DefaultCompletionVerifier } from '../runtime/verification/completion-verifier.js'
import type { CompletionCheck } from '../runtime/verification/verification-result.js'
import { GitWorktreeSession, type ApplyResult } from '../runtime/workspace/git-worktree-session.js'
import { CaptureVerificationSink } from './capture-verification-sink.js'

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
  const agent = createCodeDenAgent(
    input.provider,
    undefined,
    input.security,
    new DefaultCompletionVerifier(baseline),
  )
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
    },
  )
  let apply: ApplyResult | undefined
  if (result.status === 'verified_complete' && result.submission?.type === 'files') {
    apply = await input.session.applyToOrigin(result.submission.changedPaths)
  }
  return { result, baseline, lastCheck: capture.lastCheck, apply }
}
