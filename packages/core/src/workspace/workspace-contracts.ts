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

export interface WorkspaceFileDiff {
  path: string
  before: string
  after: string
  binary?: boolean
  deleted?: boolean
}

export interface WorkspacePort {
  readonly root: string
  readonly verificationCommandsAllowed: boolean
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  deleteFile?(path: string): Promise<void>
  exec(command: CommandSpec): Promise<CommandResult>
  changedPaths(): Promise<string[]>
  fileDiffs?(): Promise<WorkspaceFileDiff[]>
  reset(): Promise<void>
  dispose(): Promise<void>
}

export interface WorkspaceFactory {
  create(fixture: WorkspaceFixture, options?: WorkspaceCreateOptions): Promise<WorkspacePort>
}

export interface WorkspaceCreateOptions {
  signal?: AbortSignal
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
