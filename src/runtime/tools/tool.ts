import type { ZodType } from 'zod'
import type { EventSink } from '../../core/events/event-sink.js'
import type { SecretLeakGuard } from '../../security/secret-leak-guard.js'
import type { SecretRedactor } from '../../security/secret-redactor.js'
import type { SensitivePathPolicy } from '../../security/sensitive-path-policy.js'
import type { WorkspacePolicy } from '../workspace/workspace-policy.js'
import type { ToolOutput } from './tool-result.js'

export interface ToolSecurity {
  redactor: SecretRedactor
  guard: SecretLeakGuard
  paths: SensitivePathPolicy
}

export interface ToolContext {
  workspaceRoot: string
  /** Parent task's path scope, propagated to delegated agents. */
  allowedPaths?: readonly string[]
  policy: WorkspacePolicy
  eventSink: EventSink
  abortSignal?: AbortSignal
  security?: ToolSecurity
  subagentDepth?: number
  confirmTool?: (
    toolName: string,
    arguments_: unknown,
    abortSignal?: AbortSignal,
  ) => Promise<boolean>
}

export interface Tool<TInput = unknown> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodType<TInput>
  readonly sideEffect: 'read' | 'write' | 'process'
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>
}
