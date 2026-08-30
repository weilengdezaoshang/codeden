import { z } from 'zod'
import type { Grader } from './grader.js'

const BaseCriterionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
  weight: z.number().positive().default(1),
  critical: z.boolean().optional(),
})

const TextCriterionSchema = z.discriminatedUnion('kind', [
  BaseCriterionSchema.extend({
    kind: z.literal('contains'),
    value: z.string().min(1),
    caseSensitive: z.boolean().default(false),
  }),
  BaseCriterionSchema.extend({
    kind: z.literal('not_contains'),
    value: z.string().min(1),
    caseSensitive: z.boolean().default(false),
  }),
  BaseCriterionSchema.extend({ kind: z.literal('max_chars'), value: z.number().int().positive() }),
  BaseCriterionSchema.extend({ kind: z.literal('max_lines'), value: z.number().int().positive() }),
])

export const PersonaRubricGraderConfigSchema = z
  .object({
    type: z.literal('persona-rubric'),
    threshold: z.number().min(0).max(1).default(1),
    criteria: z.array(TextCriterionSchema).min(1),
  })
  .strict()
  .refine(
    (value) => new Set(value.criteria.map((item) => item.id)).size === value.criteria.length,
    { message: '人格评分规则编号不得重复' },
  )

export type PersonaRubricGraderConfig = z.infer<typeof PersonaRubricGraderConfigSchema>

export class PersonaRubricGrader implements Grader<PersonaRubricGraderConfig> {
  readonly type = 'persona-rubric'

  async grade(config: PersonaRubricGraderConfig, context: Parameters<Grader['grade']>[1]) {
    const parsed = PersonaRubricGraderConfigSchema.parse(config)
    const response = context.finalResponse ?? ''
    if (!response.trim()) {
      return {
        graderType: this.type,
        passed: false,
        score: 0,
        message: '缺少有效最终回复，无法评估人格',
        evidence: ['response:missing'],
      }
    }
    const results = parsed.criteria.map((criterion) => ({
      criterion,
      passed: matches(response, criterion),
    }))
    const totalWeight = results.reduce((sum, result) => sum + result.criterion.weight, 0)
    const passedWeight = results
      .filter((result) => result.passed)
      .reduce((sum, result) => sum + result.criterion.weight, 0)
    const score = totalWeight === 0 ? 0 : passedWeight / totalWeight
    const failed = results.filter((result) => !result.passed).map((result) => result.criterion.id)
    return {
      graderType: this.type,
      passed:
        score >= parsed.threshold &&
        results.every((result) => !result.criterion.critical || result.passed),
      score,
      message:
        failed.length === 0 ? '人格 Rubric 全部通过' : `人格 Rubric 未通过：${failed.join(', ')}`,
      evidence: failed.map((id) => `criterion:${id}`),
    }
  }
}

type Criterion = z.infer<typeof TextCriterionSchema>

function matches(response: string, criterion: Criterion): boolean {
  if (criterion.kind === 'max_chars') {
    return response.length <= criterion.value
  }
  if (criterion.kind === 'max_lines') {
    return response.split(/\r?\n/u).length <= criterion.value
  }
  const content = criterion.caseSensitive ? response : response.toLowerCase()
  const expected = criterion.caseSensitive ? criterion.value : criterion.value.toLowerCase()
  return criterion.kind === 'contains' ? content.includes(expected) : !content.includes(expected)
}
