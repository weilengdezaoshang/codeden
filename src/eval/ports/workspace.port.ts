export interface CommandSpec {
  command: string
  args?: string[]
  timeoutMs?: number
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface WorkspacePort {
  readonly root: string
  readonly verificationCommandsAllowed: boolean
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exec(command: CommandSpec): Promise<CommandResult>
  changedPaths(): Promise<string[]>
  reset(): Promise<void>
  dispose(): Promise<void>
}

export interface WorkspaceFactory {
  create(fixture: WorkspaceFixture): Promise<WorkspacePort>
}

export interface RepositoryFixture {
  repository: string
  baseCommit: string
  testPatch: string
  environmentSetupCommit?: string
}

export interface WorkspaceFixture {
  path: string
  repository?: RepositoryFixture
}
