import type { TaskSpec } from '../../core/task/task-spec.js'
import type { CommandResult, CommandSpec } from '../../eval/ports/workspace.port.js'
import { clipHeadTail, MAX_EVIDENCE_CHARS } from './clip-text.js'
import { splitVerificationCommand } from './command-split.js'
import type { CompletionCheck } from './verification-result.js'

export async function verifyCommands(
  taskSpec: TaskSpec,
  exec: (command: CommandSpec) => Promise<CommandResult>,
): Promise<CompletionCheck> {
  if (taskSpec.verificationCommands.length === 0) {
    return { passed: true, message: 'No verification commands', evidence: [] }
  }

  const evidence: string[] = []
  for (const raw of taskSpec.verificationCommands) {
    const spec = splitVerificationCommand(raw)
    if (!spec) {
      return { passed: false, message: 'Empty verification command', evidence }
    }
    const result = await exec(spec)
    evidence.push(`${raw} -> exit ${result.exitCode}`)
    if (result.exitCode !== 0) {
      return {
        passed: false,
        message: `Verification command failed: ${raw}`,
        evidence: [
          ...evidence,
          clipHeadTail(`${result.stdout}\n${result.stderr}`, MAX_EVIDENCE_CHARS),
        ],
      }
    }
  }

  return { passed: true, message: 'Verification commands passed', evidence }
}
