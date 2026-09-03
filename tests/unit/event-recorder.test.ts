import { describe, expect, it } from 'vitest'
import { InMemoryEvalRepository } from '../../packages/eval-engine/src/adapters/repositories/in-memory-eval.repository.js'
import { EventRecorder } from '../../packages/eval-engine/src/application/event-recorder.js'

describe('测试套件：事件记录器', () => {
  it('串行化同一 Trial 的并发事件并保留完整路由', async () => {
    const repository = new InMemoryEvalRepository()
    const recorder = new EventRecorder(repository, 'benchmark-run-1', 'trial-1', undefined, {
      jobId: 'job-1',
      benchmarkRunId: 'benchmark-run-1',
    })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recorder.emit('harness', 'harness.output', { index }),
      ),
    )

    const events = await repository.getEvents('trial-1')
    expect(events).toHaveLength(20)
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    )
    expect(new Set(events.map((event) => event.jobId))).toEqual(new Set(['job-1']))
    expect(new Set(events.map((event) => event.benchmarkRunId))).toEqual(
      new Set(['benchmark-run-1']),
    )
  })
})
