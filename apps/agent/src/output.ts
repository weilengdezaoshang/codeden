import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import type { AgentSubmission } from '@codeden/core/agent-submission.js'
import type { SecretRedactor } from '@codeden/core/security/secret-redactor.js'

export function printSubmission(
  submission: AgentSubmission | undefined,
  redactor: SecretRedactor,
): void {
  if (submission?.type === 'files') {
    printSafe(`Changed paths: ${submission.changedPaths.join(', ') || '(none)'}`, redactor)
  }
}

export function printSafe(line: string, redactor?: SecretRedactor): void {
  console.log(redactor ? redactor.redact(line) : line)
}

export function printError(error: unknown, redactor?: SecretRedactor): void {
  const message = CodeDenError.isCodeDenError(error)
    ? error.message
    : error instanceof Error
      ? error.message
      : 'Command failed'
  console.error(redactor ? redactor.redact(message) : message)
}
