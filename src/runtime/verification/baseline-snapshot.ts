export interface BaselineSnapshot {
  command: string
  exitCode: number
  failing: string[]
  fingerprint?: string
  testFiles: string[]
}
