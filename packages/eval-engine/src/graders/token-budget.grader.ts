import { z } from 'zod'
import type { Grader } from './grader.js'

export const TokenBudgetGraderConfigSchema = z
  .object({
    type: z.literal('token-budget'),
    maxTokens: z.number().int().nonnegative(),
    maxRequests: z.number().int().positive().optional(),
  })
  .strict()

export class TokenBudgetGrader implements Grader<z.infer<typeof TokenBudgetGraderConfigSchema>> {
  readonly type = 'token-budget'
  async grade(
    config: z.infer<typeof TokenBudgetGraderConfigSchema>,
    context: Parameters<Grader['grade']>[1],
  ) {
    const parsed = TokenBudgetGraderConfigSchema.parse(config)
    const metrics = context.metrics
    const usage = metrics?.tokenUsage
    const complete =
      metrics &&
      usage?.status === 'complete' &&
      usage.collectionComplete !== false &&
      usage.totalRequests > 0 &&
      usage.measuredRequests === metrics.modelRequests &&
      usage.totalRequests === metrics.modelRequests
    if (!complete) {
      return {
        graderType: this.type,
        passed: false,
        score: 0,
        message: 'Token 计量不完整，不能评估消耗',
        evidence: ['token_usage:incomplete'],
      }
    }
    const tokens = metrics.inputTokens + metrics.outputTokens
    const passed =
      tokens <= parsed.maxTokens &&
      (parsed.maxRequests === undefined || metrics.modelRequests <= parsed.maxRequests)
    return {
      graderType: this.type,
      passed,
      score: passed ? 1 : 0,
      message: passed ? 'Token 消耗在预算内' : 'Token 或模型请求次数超出预算',
      evidence: [`tokens:${tokens}`, `requests:${metrics.modelRequests}`],
    }
  }
}
