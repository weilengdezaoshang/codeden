import { z } from 'zod'
import { parseWithSchema } from '../../core/errors/codeden-error.js'

export const TrialMetricsSchema = z.object({
  durationMs: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  modelRequests: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolFailures: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
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
    ...overrides,
  }
}

export function parseTrialMetrics(input: unknown): TrialMetrics {
  return parseWithSchema(TrialMetricsSchema, input, 'Invalid TrialMetrics')
}
