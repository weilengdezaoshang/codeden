import { z } from 'zod'

/** 不同评测集归一化后的官方判定结果。 */
export const NormalizedBenchmarkResultSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'error', 'not_run']),
    /** SWE-bench 等评测集的最终 resolved 语义。 */
    resolved: z.boolean().nullable().optional(),
    score: z.number().finite().optional(),
    scores: z.record(z.string(), z.number().finite()),
    graderName: z.string().min(1),
    graderVersion: z.string().min(1).optional(),
    reportArtifactId: z.string().min(1).optional(),
    message: z.string().optional(),
    /** 第三方报告中的原始状态，便于诊断适配错误。 */
    externalStatus: z.string().optional(),
  })
  .strict()

export type NormalizedBenchmarkResult = z.infer<typeof NormalizedBenchmarkResultSchema>

/** 第三方结果格式到平台结果格式的适配端口。 */
export interface ResultNormalizer<TExternal> {
  normalize(input: TExternal): NormalizedBenchmarkResult
}
