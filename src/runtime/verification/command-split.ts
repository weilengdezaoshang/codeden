import type { CommandSpec } from '../../eval/ports/workspace.port.js'

export function splitVerificationCommand(raw: string): CommandSpec | undefined {
  const [command, ...args] = raw.split(' ').filter(Boolean)
  if (!command) {
    return undefined
  }
  return { command, args, timeoutMs: 30_000 }
}
