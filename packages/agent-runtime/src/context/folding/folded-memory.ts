import { z } from 'zod'

/**
 * FoldedSessionMemory —— 主计划 8.7 原样契约。
 * 折叠结果是 Session 的派生投影，不替代原始事件；必须保留 source range 和
 * sourceDigest，用于恢复时判断摘要是否过期或损坏。
 */
export const FoldTriggerSchema = z.enum(['auto', 'manual', 'tool', 'recovery'])
export type FoldTrigger = z.infer<typeof FoldTriggerSchema>

export const KeyEventSchema = z.object({
  /** 事件来源轮次 ID；旧快照允许缺省。 */
  turnId: z.string().min(1).optional(),
  kind: z.enum(['tool', 'decision', 'obstacle', 'milestone']),
  description: z.string().min(1),
})
export type KeyEvent = z.infer<typeof KeyEventSchema>

export const NextActionSchema = z.object({
  description: z.string().min(1),
  relatedTool: z.string().min(1).optional(),
})
export type NextAction = z.infer<typeof NextActionSchema>

export const ToolExperienceSchema = z.object({
  tool: z.string().min(1),
  calls: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  /** 该工具的确定性经验备注（如最后一次失败原因），可缺省。 */
  note: z.string().optional(),
})
export type ToolExperience = z.infer<typeof ToolExperienceSchema>

export const FoldedSessionMemorySchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  createdAt: z.iso.datetime(),
  trigger: FoldTriggerSchema,
  sourceSequenceRange: z.object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }),
  episodeMemory: z.object({
    taskDescription: z.string().min(1),
    keyEvents: z.array(KeyEventSchema),
    currentProgress: z.string(),
  }),
  workingMemory: z.object({
    immediateGoal: z.string().min(1),
    currentChallenges: z.array(z.string()),
    nextActions: z.array(NextActionSchema),
  }),
  toolMemory: z.object({
    toolsUsed: z.array(ToolExperienceSchema),
    derivedRules: z.array(z.string()),
  }),
  sourceDigest: z.string().min(1),
})
export type FoldedSessionMemory = z.infer<typeof FoldedSessionMemorySchema>

/**
 * 折叠投影 = 主计划 8.7 记忆 + 投影元数据。
 * degraded=true 表示由确定性回退路径产出（无 LLM 摘要增强层），不得伪装成完整恢复（主计划 9.20）。
 */
export const FoldProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  degraded: z.boolean(),
  memory: FoldedSessionMemorySchema,
})
export type FoldProjection = z.infer<typeof FoldProjectionSchema>

/** 投影文件损坏或校验失败时抛出；调用方应回退旧历史而不是采用损坏投影。 */
export class CorruptedFoldProjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptedFoldProjectionError'
  }
}
