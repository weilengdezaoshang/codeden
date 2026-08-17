import type { EvalRunSummary } from '../application/eval-runner.js'

export class ConsoleReporter {
  constructor(private readonly write: (line: string) => void = console.log) {}

  report(summary: EvalRunSummary, agentName: string): void {
    for (const trial of summary.trials) {
      this.write(`Case: ${trial.caseId}`)
      this.write(`Agent: ${agentName}`)
      this.write(`Execution: ${trial.execution.status}`)
      this.write(`Submission: ${trial.submission.status}`)
      this.write(`Verification: ${trial.verification.status}`)
      this.write(`Resolved: ${trial.resolved ? 'yes' : 'no'}`)
      this.write(`Turns: ${trial.metrics.turns}`)
      this.write(`Tool calls: ${trial.metrics.toolCalls}`)
      this.write(`Duration: ${Math.round(trial.metrics.durationMs)}ms`)
      this.write('')
    }

    if (summary.trials.length > 1) {
      this.write(`Total Cases: ${summary.totalCases}`)
      this.write(`Passed Cases: ${summary.passedCases}`)
      this.write(`Failed Cases: ${summary.failedCases}`)
      this.write(`Infrastructure Errors: ${summary.infrastructureErrors}`)
      this.write(`Pass Rate: ${(summary.passRate * 100).toFixed(1)}%`)
      this.write(`Total Duration: ${Math.round(summary.durationMs)}ms`)
      this.write(`Tool Calls: ${summary.toolCalls}`)
      this.write(`Token Usage: ${summary.inputTokens}+${summary.outputTokens}`)
    }
  }
}
