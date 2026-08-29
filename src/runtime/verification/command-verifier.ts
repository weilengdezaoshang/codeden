import type { TaskSpec } from '../../core/task/task-spec.js'
import type { CommandResult, CommandSpec } from '../../eval/ports/workspace.port.js'
import { clipHeadTail, MAX_EVIDENCE_CHARS } from './clip-text.js'
import { splitVerificationCommand } from './command-split.js'
import type { CompletionCheck } from './verification-result.js'
import { commandVerificationSteps } from '../../core/task/verification-plan.js'

export async function verifyCommands(
  taskSpec: TaskSpec,
  exec: (command: CommandSpec) => Promise<CommandResult>,
): Promise<CompletionCheck> {
  const steps = commandVerificationSteps(taskSpec.verificationPlan)
  if (steps.length === 0) {
    return { passed: true, message: 'No verification commands', evidence: [] }
  }

  const evidence: string[] = []
  const stepResults: NonNullable<CompletionCheck['stepResults']> = []
  for (const [index, step] of steps.entries()) {
    const raw = step.command
    const spec = splitVerificationCommand(raw, step.timeoutMs)
    if (!spec) {
      return { passed: false, message: 'Empty verification command', evidence, stepResults }
    }
    let result: CommandResult
    try {
      result = await exec(spec)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stepResults.push({
        stepId: step.id,
        kind: step.kind,
        status: 'error',
        required: step.required,
        durationMs: 0,
        message: `Command error: ${raw}`,
        evidence: [clipHeadTail(message, MAX_EVIDENCE_CHARS)],
      })
      evidence.push(`${raw} -> error`)
      if (step.required) {
        appendSkippedSteps(stepResults, steps.slice(index + 1))
        return {
          passed: false,
          message: `Verification command errored: ${raw}`,
          evidence: [...evidence, clipHeadTail(message, MAX_EVIDENCE_CHARS)],
          stepResults,
        }
      }
      continue
    }
    evidence.push(`${raw} -> exit ${result.exitCode}`)
    const passed = result.exitCode === 0
    stepResults.push({
      stepId: step.id,
      kind: step.kind,
      status: passed ? 'passed' : 'failed',
      required: step.required,
      durationMs: result.durationMs,
      message: passed ? `Command passed: ${raw}` : `Command failed: ${raw}`,
      evidence: passed
        ? [`${raw} -> exit ${result.exitCode}`]
        : [clipHeadTail(`${result.stdout}\n${result.stderr}`, MAX_EVIDENCE_CHARS)],
    })
    if (!passed && step.required) {
      appendSkippedSteps(stepResults, steps.slice(index + 1))
      return {
        passed: false,
        message: `Verification command failed: ${raw}`,
        evidence: [
          ...evidence,
          clipHeadTail(`${result.stdout}\n${result.stderr}`, MAX_EVIDENCE_CHARS),
        ],
        stepResults,
      }
    }
  }

  const hasOptionalFailures = stepResults.some((step) => !step.required && step.status !== 'passed')
  return {
    passed: true,
    message: hasOptionalFailures
      ? 'Required verification commands passed; optional checks failed'
      : 'Verification commands passed',
    evidence,
    stepResults,
  }
}

function appendSkippedSteps(
  results: NonNullable<CompletionCheck['stepResults']>,
  steps: ReturnType<typeof commandVerificationSteps>,
): void {
  results.push(
    ...steps.map((step) => ({
      stepId: step.id,
      kind: step.kind,
      status: 'skipped' as const,
      required: step.required,
      durationMs: 0,
      message: 'Skipped after a required verification step failed',
      evidence: [],
    })),
  )
}
