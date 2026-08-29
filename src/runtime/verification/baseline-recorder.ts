import type { TaskSpec } from '../../core/task/task-spec.js'
import type { AgentWorkspaceView } from '../../eval/ports/agent.port.js'
import type { CommandResult } from '../../eval/ports/workspace.port.js'
import type { BaselineSnapshot } from './baseline-snapshot.js'
import { splitVerificationCommand } from './command-split.js'
import { fingerprintOutput, parseFailingIdentities } from './failure-identity-parser.js'
import { listTestFiles } from './test-files.js'
import { commandVerificationSteps } from '../../core/task/verification-plan.js'

export async function captureBaseline(
  taskSpec: TaskSpec,
  workspace: AgentWorkspaceView,
): Promise<BaselineSnapshot | undefined> {
  const steps = commandVerificationSteps(taskSpec.verificationPlan).filter((step) => step.required)
  if (steps.length === 0) {
    return undefined
  }
  const testFiles = await listTestFiles(workspace.root)
  if (!workspace.exec) {
    return {
      command: steps.map((step) => step.command).join(' && '),
      exitCode: 1,
      failing: [],
      testFiles,
    }
  }
  const requiredTask: TaskSpec = {
    ...taskSpec,
    verificationCommands: steps.map((step) => step.command),
    verificationPlan: {
      schemaVersion: 1,
      steps: [...taskSpec.verificationPlan.steps.filter((step) => step.kind === 'diff'), ...steps],
    },
  }
  const run = await runVerificationCommands(requiredTask, workspace.exec.bind(workspace))
  return toSnapshot(requiredTask, testFiles, run)
}

export async function runVerificationCommands(
  taskSpec: TaskSpec,
  exec: NonNullable<AgentWorkspaceView['exec']>,
): Promise<{ exitCode: number; output: string }> {
  const chunks: string[] = []
  let exitCode = 0
  for (const step of commandVerificationSteps(taskSpec.verificationPlan)) {
    const spec = splitVerificationCommand(step.command, step.timeoutMs)
    if (!spec) {
      continue
    }
    const result: CommandResult = await exec(spec)
    chunks.push(`${result.stdout}\n${result.stderr}`)
    if (result.exitCode !== 0) {
      exitCode = result.exitCode
    }
  }
  return { exitCode, output: chunks.join('\n') }
}

export function toSnapshot(
  taskSpec: TaskSpec,
  testFiles: string[],
  run: { exitCode: number; output: string },
): BaselineSnapshot {
  const failing = parseFailingIdentities(run.output)
  const snapshot: BaselineSnapshot = {
    command: commandVerificationSteps(taskSpec.verificationPlan)
      .map((step) => step.command)
      .join(' && '),
    exitCode: run.exitCode,
    failing,
    testFiles,
  }
  if (failing.length === 0 && run.exitCode !== 0) {
    snapshot.fingerprint = fingerprintOutput(run.output)
  }
  return snapshot
}
