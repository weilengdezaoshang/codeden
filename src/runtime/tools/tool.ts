import type { ZodType } from 'zod'
import type { EventSink } from '../../core/events/event-sink.js'
import type { WorkspacePolicy } from '../workspace/workspace-policy.js'
import type { ToolOutput } from './tool-result.js'

export interface ToolContext {
  workspaceRoot: string
  policy: WorkspacePolicy
  eventSink: EventSink
  abortSignal?: AbortSignal
}

export interface Tool<TInput = unknown> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodType<TInput>
  readonly sideEffect: 'read' | 'write' | 'process'
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>
}
