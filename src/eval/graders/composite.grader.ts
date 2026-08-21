import { z } from 'zod'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import type { GraderResult, VerificationResult } from '../domain/verification-result.js'
import type { Grader, GraderContext } from './grader.js'
import { ChangedPathsGrader, ChangedPathsGraderConfigSchema } from './changed-paths.grader.js'
import { CommandGrader, CommandGraderConfigSchema } from './command.grader.js'
import { JsonFieldGrader, JsonFieldGraderConfigSchema } from './json-field.grader.js'

const graderConfigs = z.discriminatedUnion('type', [
  JsonFieldGraderConfigSchema,
  ChangedPathsGraderConfigSchema,
  CommandGraderConfigSchema,
])

export class CompositeGrader {
  constructor(
    private readonly graders: Record<string, Grader> = {
      'json-field': new JsonFieldGrader(),
      'changed-paths': new ChangedPathsGrader(),
      command: new CommandGrader(),
    },
  ) {}

  async gradeAll(rawConfigs: unknown[], context: GraderContext): Promise<VerificationResult> {
    const results: GraderResult[] = []
    const scores: Record<string, number> = {}

    for (const raw of rawConfigs) {
      const config = graderConfigs.parse(raw)
      const grader = this.graders[config.type]
      if (!grader) {
        throw new CodeDenError({
          code: ErrorCodes.VERIFIER_ERROR,
          category: 'verifier',
          message: `Unknown grader type: ${config.type}`,
          retryable: false,
        })
      }

      try {
        const result = await grader.grade(config, context)
        results.push(result)
        scores[`${result.graderType}:${results.length}`] = result.score
      } catch (error) {
        throw new CodeDenError({
          code: ErrorCodes.VERIFIER_ERROR,
          category: 'verifier',
          message: error instanceof Error ? error.message : 'Grader threw an exception',
          retryable: false,
          details: { graderType: config.type },
        })
      }
    }

    const passed = results.every((result) => result.passed)
    return {
      status: passed ? 'passed' : 'failed',
      scores,
      graderResults: results,
      message: passed ? 'All graders passed' : 'One or more graders failed',
    }
  }
}
