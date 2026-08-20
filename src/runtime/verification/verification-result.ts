export interface CompletionCheck {
  passed: boolean
  message: string
  evidence: string[]
}

export function mergeChecks(checks: CompletionCheck[]): CompletionCheck {
  const failed = checks.filter((check) => !check.passed)
  if (failed.length === 0) {
    return {
      passed: true,
      message: 'Completion verification passed',
      evidence: checks.flatMap((check) => check.evidence),
    }
  }
  return {
    passed: false,
    message: failed.map((check) => check.message).join('; '),
    evidence: failed.flatMap((check) => check.evidence),
  }
}
