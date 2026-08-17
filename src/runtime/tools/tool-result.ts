import type { CodeDenErrorData } from '../../core/errors/codeden-error.js'

export type ToolOutput = unknown

export type ToolResult =
  | {
      ok: true
      callId: string
      toolName: string
      output: unknown
      durationMs: number
    }
  | {
      ok: false
      callId: string
      toolName: string
      error: CodeDenErrorData
      durationMs: number
    }
