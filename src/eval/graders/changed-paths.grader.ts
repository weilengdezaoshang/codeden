import { z } from 'zod'
import type { GraderResult } from '../domain/verification-result.js'
import type { Grader, GraderContext } from './grader.js'

export const ChangedPathsGraderConfigSchema = z.object({
  type: z.literal('changed-paths'),
  allowed: z.array(z.string().min(1)).min(1),
})

export type ChangedPathsGraderConfig = z.infer<typeof ChangedPathsGraderConfigSchema>

export class ChangedPathsGrader implements Grader<ChangedPathsGraderConfig> {
  readonly type = 'changed-paths'

  async grade(config: ChangedPathsGraderConfig, context: GraderContext): Promise<GraderResult> {
    const changed = await context.workspace.changedPaths()
    const allowed = new Set(config.allowed)
    const unexpected = changed.filter((item) => !allowed.has(item))
    const passed = unexpected.length === 0
    return {
      graderType: this.type,
      passed,
      score: passed ? 1 : 0,
      message: passed
        ? `Changed paths are within allowed set: ${changed.join(', ') || '(none)'}`
        : `Unexpected changed paths: ${unexpected.join(', ')}`,
      evidence: changed,
    }
  }
}
