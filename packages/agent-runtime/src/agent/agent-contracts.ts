import { z } from 'zod'
import { TaskSpecSchema } from '@codeden/core/task/task-spec.js'
import type { EventSink } from '@codeden/core/events/event-sink.js'
import { AgentSubmissionSchema } from '@codeden/core/agent-submission.js'
import { TrialMetricsSchema } from '@codeden/core/metrics.js'
import type { CommandResult, CommandSpec } from '@codeden/core/workspace/workspace-contracts.js'
import {
  ModelMessageRoleSchema,
  ModelToolCallSchema,
  type ModelMessage,
} from '../models/model-types.js'
import type { MemoryEntry } from '../memory/memory-store.js'
import type { SkillDefinition } from '../skills/skill-loader.js'
import type { CompletionVerifier } from '../verification/completion-verifier.js'
import { VerifiedWorkspaceSnapshotSchema } from '../attempts/verified-workspace-snapshot.js'
import { CompletionCheckSchema } from '../verification/verification-result.js'

export const AgentTaskSchema = z.object({
  taskSpec: TaskSpecSchema,
  prompt: z.string().min(1),
})

export type AgentTask = z.infer<typeof AgentTaskSchema>

export type ApprovalMode = 'ask' | 'auto'

export const AgentRunResultSchema = z.object({
  status: z.enum(['submitted', 'verified_complete', 'timeout', 'budget_exhausted', 'agent_error']),
  stopReason: z.string().optional(),
  finalResponse: z.string().default(''),
  submission: AgentSubmissionSchema.optional(),
  verifiedSnapshot: VerifiedWorkspaceSnapshotSchema.optional(),
  verification: CompletionCheckSchema.optional(),
  /** 本轮新增的对话消息（含工具调用与结果），供会话跨轮重放。 */
  turnTranscript: z
    .array(
      z.object({
        role: ModelMessageRoleSchema,
        content: z.string(),
        toolCalls: z.array(ModelToolCallSchema).optional(),
        toolCallId: z.string().optional(),
      }),
    )
    .optional(),
  metrics: TrialMetricsSchema,
})

export type AgentRunResult = z.infer<typeof AgentRunResultSchema>

export interface AgentWorkspaceView {
  readonly root: string
  changedPaths(): Promise<string[]>
  exec?(command: CommandSpec): Promise<CommandResult>
}

export interface AgentRunContext {
  runId: string
  trialId: string
  workspace: AgentWorkspaceView
  eventSink: EventSink
  abortSignal?: AbortSignal
  limits: {
    maxTurns: number
    maxToolCalls: number
  }
  submissionType: 'files' | 'text'
  allowedPaths?: string[]
  conversation?: ModelMessage[]
  readOnly?: boolean
  /** Controls whether tools with side effects require an interactive confirmation. */
  approvalMode?: ApprovalMode
  persona?: string
  /** 离线评测只使用 fixture 中的指令，交互默认允许用户指令。 */
  includeUserInstructions?: boolean
  /** Persistent memory is untrusted reference context and never grants permissions. */
  memory?: readonly MemoryEntry[]
  /** Receives incremental model text when the provider supports streaming. */
  onTextDelta?: (delta: string) => void | Promise<void>
  skills?: readonly SkillDefinition[]
  activeSkill?: string
  /** Per-run verifier, used when verification depends on a baseline captured for this turn. */
  completionVerifier?: CompletionVerifier
  subagentDepth?: number
  confirmTool?: (
    toolName: string,
    arguments_: unknown,
    abortSignal?: AbortSignal,
  ) => Promise<boolean>
}

export interface AgentPort {
  readonly name: string
  run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult>
}
