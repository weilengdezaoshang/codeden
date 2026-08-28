import type { SecretLeakGuard } from '../../security/secret-leak-guard.js'
import type { SecretRedactor } from '../../security/secret-redactor.js'
import type { EvalRunSummary } from '../application/eval-runner.js'

export class ConsoleReporter {
  constructor(
    private readonly write: (line: string) => void = console.log,
    private readonly redactor?: SecretRedactor,
    private readonly guard?: SecretLeakGuard,
  ) {}

  report(summary: EvalRunSummary, agentName: string): void {
    for (const trial of summary.trials) {
      this.safeWrite(`Case: ${trial.caseId}`)
      if (trial.benchmark) {
        this.safeWrite(
          `Benchmark: ${trial.benchmark.name}${trial.benchmark.version ? `@${trial.benchmark.version}` : ''}`,
        )
      }
      this.safeWrite(`Agent: ${agentName}`)
      this.safeWrite(`Execution: ${trial.execution.status}`)
      this.safeWrite(`Submission: ${trial.submission.status}`)
      this.safeWrite(`Verification: ${trial.verification.status}`)
      this.safeWrite(`Resolved: ${trial.resolved ? 'yes' : 'no'}`)
      if (trial.failure) {
        this.safeWrite(`Failure: ${trial.failure.category} - ${trial.failure.message}`)
        if (trial.failure.identities.length > 0) {
          this.safeWrite(`Failing identities: ${trial.failure.identities.join(', ')}`)
        }
        if (trial.failure.fingerprint) {
          this.safeWrite(`Failure fingerprint: ${trial.failure.fingerprint}`)
        }
      }
      this.safeWrite(`Turns: ${trial.metrics.turns}`)
      this.safeWrite(`Tool calls: ${trial.metrics.toolCalls}`)
      this.safeWrite(`Duration: ${Math.round(trial.metrics.durationMs)}ms`)
      this.safeWrite('')
    }

    if (summary.trials.length > 1) {
      this.safeWrite(`Total Cases: ${summary.totalCases}`)
      this.safeWrite(`Passed Cases: ${summary.passedCases}`)
      this.safeWrite(`Failed Cases: ${summary.failedCases}`)
      this.safeWrite(`Infrastructure Errors: ${summary.infrastructureErrors}`)
      this.safeWrite(`Pass Rate: ${(summary.passRate * 100).toFixed(1)}%`)
      this.safeWrite(`Total Duration: ${Math.round(summary.durationMs)}ms`)
      this.safeWrite(`Tool Calls: ${summary.toolCalls}`)
      this.safeWrite(`Token Usage: ${summary.inputTokens}+${summary.outputTokens}`)
    }
  }

  private safeWrite(line: string): void {
    const safe = this.redactor ? this.redactor.redact(line) : line
    this.guard?.assertSafe(safe, 'console')
    this.write(safe)
  }
}
