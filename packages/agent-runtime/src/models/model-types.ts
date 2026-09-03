import { z } from 'zod'

export const ModelStopReasonSchema = z.enum(['end_turn', 'tool_use', 'max_tokens', 'unknown'])
export type ModelStopReason = z.infer<typeof ModelStopReasonSchema>

export const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
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

export interface ModelRequest {
  messages: ModelMessage[]
  tools: ToolDefinition[]
  signal?: AbortSignal
}

export interface ModelResponse {
  text: string
  toolCalls: ModelToolCall[]
  stopReason: ModelStopReason
  usage: ModelUsage
}
