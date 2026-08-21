import { z } from 'zod'
import type { GraderResult } from '../domain/verification-result.js'
import type { Grader, GraderContext } from './grader.js'

export const CommandGraderConfigSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
  expectedExitCode: z.number().int().default(0),
})

export type CommandGraderConfig = z.infer<typeof CommandGraderConfigSchema>

export class CommandGrader implements Grader<CommandGraderConfig> {
  readonly type = 'command'

  async grade(config: CommandGraderConfig, context: GraderContext): Promise<GraderResult> {
    const result = await context.workspace.exec({
      command: config.command,
      args: config.args,
      timeoutMs: config.timeoutMs,
    })
    const passed = result.exitCode === config.expectedExitCode
    return {
      graderType: this.type,
      passed,
      score: passed ? 1 : 0,
      message: passed
        ? `Command exited with ${result.exitCode}`
        : `Command exited with ${result.exitCode}; expected ${config.expectedExitCode}`,
      evidence: [result.stdout, result.stderr].filter((output) => output.length > 0),
    }
  }
}
