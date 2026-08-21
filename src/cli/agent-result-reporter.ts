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
      printSubmission(result.submission, redactor)
      printSafe(`Conflicts: ${apply.conflicts.join(', ')}`, redactor)
      if (apply.patchPath) {
        printSafe(`Patch: ${apply.patchPath}`, redactor)
      }
      return 1
    }
    printSafe('VERIFIED_COMPLETE', redactor)
    printSubmission(result.submission, redactor)
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
  return 1
}
