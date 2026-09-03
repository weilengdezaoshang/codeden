import type { ZodType } from 'zod'
import type { EventSink } from '@codeden/core/events/event-sink.js'
import type { SecretLeakGuard } from '@codeden/core/security/secret-leak-guard.js'
import type { SecretRedactor } from '@codeden/core/security/secret-redactor.js'
import type { SensitivePathPolicy } from '@codeden/core/security/sensitive-path-policy.js'
import type { WorkspacePolicy } from '../workspace/workspace-policy.js'
import type { ToolOutput } from './tool-result.js'
import type { ApprovalMode } from '../agent/agent-contracts.js'

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
  approvalMode?: ApprovalMode
  security?: ToolSecurity
  subagentDepth?: number
  includeUserInstructions?: boolean
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
  /** 根据已校验的参数判断本次调用的实际副作用类型。 */
  sideEffectForInput?(input: TInput): 'read' | 'write' | 'process'
  /** 允许本次调用的最长执行毫秒数；未声明时使用执行器默认上限。 */
  timeoutForInput?(input: TInput): number
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>
}
