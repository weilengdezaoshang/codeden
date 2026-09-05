import { z } from 'zod'

/** HumanEval 官方 JSONL 的实例格式；保留未知列以兼容衍生数据集。 */
export const HumanEvalRecordSchema = z
  .object({
    task_id: z.string().min(1),
    prompt: z.string().min(1),
    entry_point: z.string().min(1),
    canonical_solution: z.string().default(''),
    test: z.string().min(1),
  })
  .passthrough()

export type HumanEvalRecord = z.infer<typeof HumanEvalRecordSchema>
