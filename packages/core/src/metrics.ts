import { z } from 'zod'
import { parseWithSchema } from './errors/codeden-error.js'

export const TrialMetricsSchema = z
  .object({
    durationMs: z.number().nonnegative(),
    turns: z.number().int().nonnegative(),
    modelRequests: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    toolFailures: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /** 缓存读取 token 数；provider 未返回时缺省，缺失不得当作 0 参与门禁。 */
    cacheReadTokens: z.number().int().nonnegative().optional(),
    /** 缓存写入 token 数；provider 未返回时缺省。 */
    cacheCreationTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    tokenUsage: z
      .object({
        status: z.enum(['complete', 'partial', 'unavailable']),
        measuredRequests: z.number().int().nonnegative(),
        totalRequests: z.number().int().nonnegative(),
        collectionComplete: z.boolean().optional(),
      })
      .refine((value) => value.measuredRequests <= value.totalRequests, {
        message: 'Measured token requests cannot exceed total requests',
      })
      .optional(),
  })
  .superRefine((metrics, context) => {
    const usage = metrics.tokenUsage
    if (!usage) {
      return
    }
    const status =
      usage.measuredRequests === 0
        ? 'unavailable'
        : usage.measuredRequests === usage.totalRequests && usage.collectionComplete !== false
          ? 'complete'
          : 'partial'
    if (usage.totalRequests !== metrics.modelRequests || usage.status !== status) {
      context.addIssue({
        code: 'custom',
        path: ['tokenUsage'],
        message: 'Token 计量与模型请求数不一致',
      })
    }
  })

export type TrialMetrics = z.infer<typeof TrialMetricsSchema>

export function emptyMetrics(overrides: Partial<TrialMetrics> = {}): TrialMetrics {
  return {
    durationMs: 0,
    turns: 0,
    modelRequests: 0,
    toolCalls: 0,
    toolFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokenUsage: {
      status: 'unavailable',
      measuredRequests: 0,
      totalRequests: overrides.modelRequests ?? 0,
    },
    ...overrides,
  }
}

export function parseTrialMetrics(input: unknown): TrialMetrics {
  return parseWithSchema(TrialMetricsSchema, input, 'Invalid TrialMetrics')
}
