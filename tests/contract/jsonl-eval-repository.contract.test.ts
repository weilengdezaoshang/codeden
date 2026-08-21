import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonlEvalRepository } from '../../src/eval/adapters/repositories/jsonl-eval.repository.js'
import { emptyMetrics } from '../../src/eval/domain/metrics.js'

const run = {
  schemaVersion: 1 as const,
  runId: 'run-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  status: 'running' as const,
  caseIds: ['case-1'],
  agentName: 'codeden/mock-model',
}

describe('JSONL EvalRepository contract', () => {
  it('persists runs, events, and queryable benchmark trial results', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-results-'))
    const repository = new JsonlEvalRepository(root)
    await repository.createRun(run)
    await repository.appendEvent({
      schemaVersion: 1,
      runId: run.runId,
      trialId: 'trial-1',
      sequence: 0,
      timestamp: run.startedAt,
      source: 'eval',
      type: 'eval.trial.started',
      data: {},
    })
    await repository.saveTrial({
      schemaVersion: 1,
      runId: run.runId,
      trialId: 'trial-1',
      caseId: 'case-1',
      benchmark: { name: 'swebench-lite', version: '1.0', upstreamId: 'upstream-1' },
      execution: { status: 'submitted' },
      submission: { status: 'valid' },
      verification: { status: 'passed' },
      infrastructure: { status: 'ok' },
      resolved: true,
      scores: { 'command:1': 1 },
      metrics: emptyMetrics({ durationMs: 10 }),
      artifacts: [],
    })
    await repository.updateRun({ ...run, status: 'completed' })

    expect((await repository.getRun(run.runId))?.status).toBe('completed')
    expect((await repository.getTrial('trial-1'))?.benchmark?.name).toBe('swebench-lite')
    expect(await repository.getEvents('trial-1')).toHaveLength(1)
    expect(await repository.listTrials(run.runId)).toHaveLength(1)
    const lines = (await readFile(path.join(root, 'run-1.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(4)
  })

  it('rejects duplicate or backwards event sequences after persistence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-results-'))
    const repository = new JsonlEvalRepository(root)
    await repository.createRun(run)
    const event = {
      schemaVersion: 1 as const,
      runId: run.runId,
      trialId: 'trial-1',
      sequence: 0,
      timestamp: run.startedAt,
      source: 'eval' as const,
      type: 'eval.trial.started',
      data: {},
    }
    await repository.appendEvent(event)
    await expect(repository.appendEvent(event)).rejects.toMatchObject({
      code: 'INTERNAL_INVARIANT_VIOLATION',
    })
  })

  it('rejects updates for unknown runs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-results-'))
    const repository = new JsonlEvalRepository(root)
    await expect(repository.updateRun(run)).rejects.toMatchObject({
      code: 'INTERNAL_INVARIANT_VIOLATION',
    })
  })
})
