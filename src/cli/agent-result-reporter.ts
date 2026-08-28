import type { AgentRunResult } from '../eval/ports/agent.port.js'
import type { SecretRedactor } from '../security/secret-redactor.js'
import type { CompletionCheck } from '../runtime/verification/verification-result.js'
import type { ApplyResult } from '../runtime/workspace/git-worktree-session.js'
import { printSafe, printSubmission } from './output.js'

export function reportAgentResult(input: {
  result: AgentRunResult
  lastCheck?: CompletionCheck
  apply?: ApplyResult
  redactor: SecretRedactor
}): number {
  const { result, lastCheck, apply, redactor } = input
  if (result.status === 'verified_complete') {
    if (apply?.conflicts.length) {
      printSafe('Status: conflict', redactor)
      printSafe(formatUsage(result), redactor)
      printSubmission(result.submission, redactor)
      printSafe(`Conflicts: ${apply.conflicts.join(', ')}`, redactor)
      if (apply.patchPath) {
        printSafe(`Patch: ${apply.patchPath}`, redactor)
      }
      printSafe(
        'Next: Review the conflict files and apply the patch after resolving them.',
        redactor,
      )
      return 1
    }
    printSafe('VERIFIED_COMPLETE', redactor)
    printSubmission(result.submission, redactor)
    printSafe(formatUsage(result), redactor)
    if (apply) {
      printSafe(`Applied: ${apply.applied.join(', ') || '(none)'}`, redactor)
      if (apply.conflicts.length > 0) {
        printSafe(`Conflicts: ${apply.conflicts.join(', ')}`, redactor)
      }
      if (apply.patchPath) {
        printSafe(`Patch: ${apply.patchPath}`, redactor)
      }
    }
    if (result.finalResponse) {
      printSafe(result.finalResponse, redactor)
    }
    return 0
  }

  printSafe(`Status: ${result.status}`, redactor)
  printSafe(`Reason: ${result.stopReason ?? defaultReason(result.status)}`, redactor)
  printSafe(formatUsage(result), redactor)
  printSubmission(result.submission, redactor)
  if (lastCheck && !lastCheck.passed) {
    printSafe(lastCheck.message, redactor)
    for (const item of lastCheck.evidence.slice(0, 20)) {
      printSafe(item, redactor)
    }
  }
  if (result.finalResponse) {
    printSafe(result.finalResponse, redactor)
  }
  printSafe(`Next: ${nextStep(result.status, Boolean(lastCheck && !lastCheck.passed))}`, redactor)
  return 1
}

function formatUsage(result: AgentRunResult): string {
  return `Usage: ${result.metrics.turns} turns, ${result.metrics.toolCalls} tool calls, ${Math.round(result.metrics.durationMs)}ms`
}

function defaultReason(status: AgentRunResult['status']): string {
  switch (status) {
    case 'timeout':
      return 'Agent timeout'
    case 'budget_exhausted':
      return 'Execution budget exhausted'
    case 'agent_error':
      return 'Agent execution error'
    case 'submitted':
      return 'Verification did not pass'
    case 'verified_complete':
      return 'Completed'
  }
}

function nextStep(status: AgentRunResult['status'], verificationFailed: boolean): string {
  if (verificationFailed || status === 'submitted') {
    return 'Review the verification evidence and continue fixing the workspace.'
  }
  if (status === 'timeout') {
    return 'Retry with a larger timeout or a smaller task.'
  }
  if (status === 'budget_exhausted') {
    return 'Retry with higher --max-turns or --max-tool-calls.'
  }
  return 'Check the error above and retry the task.'
}
