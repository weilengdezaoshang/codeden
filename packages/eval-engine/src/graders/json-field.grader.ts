import { z } from 'zod'
import type { Grader, GraderContext } from './grader.js'
import { getJsonPointer } from './json-pointer.js'
import type { GraderResult } from '../domain/verification-result.js'

export const JsonFieldGraderConfigSchema = z.object({
  type: z.literal('json-field'),
  path: z.string().min(1),
  pointer: z.string().min(1),
  equals: z.unknown(),
})

export type JsonFieldGraderConfig = z.infer<typeof JsonFieldGraderConfigSchema>

export class JsonFieldGrader implements Grader<JsonFieldGraderConfig> {
  readonly type = 'json-field'

  async grade(config: JsonFieldGraderConfig, context: GraderContext): Promise<GraderResult> {
    let raw: string
    try {
      raw = await context.workspace.readFile(config.path)
    } catch (error) {
      return fail(config, `File not found or unreadable: ${config.path}`, [
        error instanceof Error ? error.message : String(error),
      ])
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return fail(config, `Invalid JSON in ${config.path}`, [
        error instanceof Error ? error.message : String(error),
      ])
    }

    const located = getJsonPointer(parsed, config.pointer)
    if (!located.found) {
      return fail(config, `JSON pointer not found: ${config.pointer}`, [config.pointer])
    }

    const actual = located.value
    const passed =
      Object.is(actual, config.equals) || JSON.stringify(actual) === JSON.stringify(config.equals)
    return {
      graderType: this.type,
      passed,
      score: passed ? 1 : 0,
      message: passed
        ? `${config.pointer} equals ${JSON.stringify(config.equals)}`
        : `${config.pointer} expected ${JSON.stringify(config.equals)}, got ${JSON.stringify(actual)}`,
      evidence: [JSON.stringify(actual)],
    }
  }
}

function fail(config: JsonFieldGraderConfig, message: string, evidence: string[]): GraderResult {
  return {
    graderType: 'json-field',
    passed: false,
    score: 0,
    message,
    evidence,
  }
}
