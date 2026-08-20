import type { TaskSpec } from '../../core/task/task-spec.js'
import type { CommandResult, CommandSpec } from '../../eval/ports/workspace.port.js'
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
    const [command, ...args] = raw.split(' ').filter(Boolean)
    if (!command) {
      return { passed: false, message: 'Empty verification command', evidence }
    }
    const result = await exec({ command, args, timeoutMs: 30_000 })
    evidence.push(`${raw} -> exit ${result.exitCode}`)
    if (result.exitCode !== 0) {
      return {
        passed: false,
        message: `Verification command failed: ${raw}`,
        evidence: [...evidence, result.stderr.slice(0, 500)],
      }
    }
  }

  return { passed: true, message: 'Verification commands passed', evidence }
}
