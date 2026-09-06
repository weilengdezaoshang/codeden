import { z } from 'zod'

export const ModelStopReasonSchema = z.enum(['end_turn', 'tool_use', 'max_tokens', 'unknown'])
export type ModelStopReason = z.infer<typeof ModelStopReasonSchema>

export const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** 缓存读取命中的 token 数；provider 未返回时缺省，不得当作 0 参与门禁。 */
  cacheReadTokens: z.number().int().nonnegative().optional(),
  /** 缓存写入的 token 数；provider 未返回时缺省。 */
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  status: z.enum(['complete', 'unavailable']).optional(),
})

export type ModelUsage = z.infer<typeof ModelUsageSchema>

export const ModelToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown(),
})

export type ModelToolCall = z.infer<typeof ModelToolCallSchema>

export const ModelMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool'])
export type ModelMessageRole = z.infer<typeof ModelMessageRoleSchema>

export interface ModelMessage {
  role: ModelMessageRole
  content: string
  toolCalls?: ModelToolCall[]
  toolCallId?: string
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * 模型上下文档案（窗口与输出上限）。字段全部可选：
 * 未登记的模型由 resolveModelProfile 以保守默认补齐并标记 estimated。
 */
export interface ModelProfile {
  contextWindowTokens?: number
  maxOutputTokens?: number
  supportsPromptCaching?: boolean
}

export interface ModelRequest {
  messages: ModelMessage[]
  tools: ToolDefinition[]
  signal?: AbortSignal
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface ModelResponse {
  text: string
  toolCalls: ModelToolCall[]
  stopReason: ModelStopReason
  usage: ModelUsage
}
