import { describe, expect, it } from 'vitest'
import { InMemoryEvalRepository } from '../../src/eval/adapters/repositories/in-memory-eval.repository.js'
import { emptyMetrics } from '../../src/eval/domain/metrics.js'

function event(sequence: number) {
  return {
    schemaVersion: 1 as const,
    runId: 'run-1',
    trialId: 'trial-1',
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'eval' as const,
    type: 'eval.trial.started',
    data: {},
  }
}

describe('EvalRepository contract', () => {
  it('saves and reads a run', async () => {
    const repo = new InMemoryEvalRepository()
    await repo.createRun({
      schemaVersion: 1,
      runId: 'run-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      caseIds: ['c1'],
      agentName: 'codeden/mock-model',
    })
    const loaded = await repo.getRun('run-1')
    expect(loaded?.caseIds).toEqual(['c1'])
    loaded!.caseIds.push('mutated')
    expect((await repo.getRun('run-1'))?.caseIds).toEqual(['c1'])
    await repo.updateRun({ ...loaded!, status: 'completed' })
    expect((await repo.getRun('run-1'))?.status).toBe('completed')
  })

  it('stores events per trial and rejects a backwards sequence', async () => {
    const repo = new InMemoryEvalRepository()
    await repo.appendEvent(event(0))
    await repo.appendEvent(event(1))
    await expect(repo.appendEvent(event(1))).rejects.toMatchObject({
      code: 'INTERNAL_INVARIANT_VIOLATION',
    })
    await expect(repo.appendEvent(event(0))).rejects.toMatchObject({
      code: 'INTERNAL_INVARIANT_VIOLATION',
    })
    expect(await repo.getEvents('trial-1')).toHaveLength(2)
  })

  it('saves a trial result', async () => {
    const repo = new InMemoryEvalRepository()
    await repo.saveTrial({
      schemaVersion: 1,
      runId: 'run-1',
      trialId: 'trial-1',
      caseId: 'c1',
      execution: { status: 'submitted' },
      submission: { status: 'valid' },
      verification: { status: 'passed' },
      infrastructure: { status: 'ok' },
      resolved: true,
      scores: { 'json-field:1': 1 },
      metrics: emptyMetrics({ durationMs: 10 }),
      artifacts: [],
    })
    expect((await repo.getTrial('trial-1'))?.resolved).toBe(true)
  })
})
