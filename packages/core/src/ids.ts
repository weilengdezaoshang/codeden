import { randomUUID } from 'node:crypto'

export function createId(): string {
  return randomUUID()
}

export function createRunIdentifiers(): { runId: string; trialId: string } {
  return {
    runId: createId(),
    trialId: createId(),
  }
}
