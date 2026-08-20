import { z } from 'zod'
import { TaskSpecSchema } from '../../core/task/task-spec.js'
import type { EventSink } from '../../core/events/event-sink.js'
import { AgentSubmissionSchema } from '../domain/agent-submission.js'
import { TrialMetricsSchema } from '../domain/metrics.js'
import type { CommandResult, CommandSpec } from './workspace.port.js'

export const AgentTaskSchema = z.object({
  taskSpec: TaskSpecSchema,
  prompt: z.string().min(1),
})

export type AgentTask = z.infer<typeof AgentTaskSchema>

export const AgentRunResultSchema = z.object({
  status: z.enum(['submitted', 'verified_complete', 'timeout', 'budget_exhausted', 'agent_error']),
  stopReason: z.string().optional(),
  finalResponse: z.string().default(''),
  submission: AgentSubmissionSchema.optional(),
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
}

export interface AgentPort {
  readonly name: string
  run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult>
}
