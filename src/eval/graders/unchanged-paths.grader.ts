import { z } from 'zod'
import type { GraderResult } from '../domain/verification-result.js'
import type { Grader, GraderContext } from './grader.js'

export const UnchangedPathsGraderConfigSchema = z.object({
  type: z.literal('unchanged-paths'),
  paths: z.array(z.string().min(1)).min(1),
})

export type UnchangedPathsGraderConfig = z.infer<typeof UnchangedPathsGraderConfigSchema>

export class UnchangedPathsGrader implements Grader<UnchangedPathsGraderConfig> {
  readonly type = 'unchanged-paths'

  async grade(config: UnchangedPathsGraderConfig, context: GraderContext): Promise<GraderResult> {
    const protectedPaths = new Set(config.paths)
    const changed = (await context.workspace.changedPaths()).filter((item) =>
      protectedPaths.has(item),
    )
    const passed = changed.length === 0
    return {
      graderType: this.type,
      passed,
      score: passed ? 1 : 0,
      message: passed
        ? 'Protected paths are unchanged'
        : `Protected paths changed: ${changed.join(', ')}`,
      evidence: changed,
    }
  }
}
