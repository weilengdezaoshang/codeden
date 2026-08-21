import type { TaskSpec } from '../../core/task/task-spec.js'
import type { AgentWorkspaceView } from '../../eval/ports/agent.port.js'
import type { CommandResult } from '../../eval/ports/workspace.port.js'
import type { BaselineSnapshot } from './baseline-snapshot.js'
import { splitVerificationCommand } from './command-split.js'
import { fingerprintOutput, parseFailingIdentities } from './failure-identity-parser.js'
import { listTestFiles } from './test-files.js'

export async function captureBaseline(
  taskSpec: TaskSpec,
  workspace: AgentWorkspaceView,
): Promise<BaselineSnapshot | undefined> {
  if (taskSpec.verificationCommands.length === 0) {
    return undefined
  }
  const testFiles = await listTestFiles(workspace.root)
  if (!workspace.exec) {
    return {
      command: taskSpec.verificationCommands.join(' && '),
      exitCode: 1,
      failing: [],
      testFiles,
    }
  }
  const run = await runVerificationCommands(taskSpec, workspace.exec.bind(workspace))
  return toSnapshot(taskSpec, testFiles, run)
}

export async function runVerificationCommands(
  taskSpec: TaskSpec,
  exec: NonNullable<AgentWorkspaceView['exec']>,
): Promise<{ exitCode: number; output: string }> {
  const chunks: string[] = []
  let exitCode = 0
  for (const raw of taskSpec.verificationCommands) {
    const spec = splitVerificationCommand(raw)
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
    command: taskSpec.verificationCommands.join(' && '),
    exitCode: run.exitCode,
    failing,
    testFiles,
  }
  if (failing.length === 0 && run.exitCode !== 0) {
    snapshot.fingerprint = fingerprintOutput(run.output)
  }
  return snapshot
}
