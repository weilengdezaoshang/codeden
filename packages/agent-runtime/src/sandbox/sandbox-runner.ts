export interface SandboxCommand {
  command: string
  args: string[]
  timeoutMs: number
}

export interface SandboxContext {
  workspaceRoot: string
  abortSignal?: AbortSignal
  redact?: (value: string) => string
}

export interface SandboxResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

/** Executes an agent command inside a selectable isolation backend. */
export interface SandboxRunner {
  run(command: SandboxCommand, context: SandboxContext): Promise<SandboxResult>
  dispose(): Promise<void>
}
