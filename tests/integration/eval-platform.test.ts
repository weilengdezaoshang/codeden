import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { connectDatabase, migrateDatabase } from '../../apps/eval-platform/src/platform/database.js'
import { createPlatform, type Platform } from '../../apps/eval-platform/src/platform/service.js'
import { EvalWorker } from '../../apps/eval-platform/src/platform/worker.js'
import { executeJob } from '../../apps/eval-platform/src/platform/executor.js'
import { PlatformEvalRepository } from '../../apps/eval-platform/src/platform/eval-repository.js'
import { createSecurityServices } from '@codeden/core/security/security-services.js'
import { summarize } from '@codeden/eval-engine/application/eval-runner.js'
import type { JobSnapshot } from '../../apps/eval-platform/src/platform/schema.js'

const url = process.env.CODEDEN_EVAL_TEST_DATABASE_URL
describe.skipIf(!url)('评测平台真实 PostgreSQL 集成', () => {
  let platform: Platform
  let snapshot: JobSnapshot
  const input = () => ({
    requestId: randomUUID(),
    datasetId: 'all' as const,
    modelId: 'mock' as const,
    repetitions: 1,
    allowPaid: false,
  })
  beforeAll(async () => {
    const target = new URL(url!)
    if (
      !target.pathname.endsWith('_test') ||
      !['127.0.0.1', 'localhost'].includes(target.hostname)
    ) {
      throw new Error('仅允许本机且数据库名以 _test 结尾的专用测试库')
    }
    const connection = connectDatabase(url!)
    try {
      await migrateDatabase(connection.db)
      await migrateDatabase(connection.db)
    } finally {
      await connection.pool.end()
    }
    platform = await createPlatform({ databaseUrl: url!, root: process.cwd() })
    snapshot = await platform.catalog.snapshot(input())
  }, 30_000)
  beforeEach(async () => {
    // 专用测试库，不接触用户项目或 studycommit 数据。
    await platform.store.db.$client.query(
      'TRUNCATE eval_events, eval_trials, eval_benchmark_runs, eval_jobs',
    )
  })
  afterAll(async () => {
    await platform?.close()
  })

  it('并发重复提交只创建一个持久任务，重复请求不能变更输入', async () => {
    const request = input()
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => platform.store.create(request, snapshot, platform.boss)),
    )
    expect(results.every((item) => item.status === 'fulfilled')).toBe(true)
    expect(
      new Set(results.flatMap((item) => (item.status === 'fulfilled' ? [item.value.id] : []))).size,
    ).toBe(1)
    expect(await platform.store.list(0, 10)).toHaveLength(1)
    await expect(
      platform.store.create({ ...request, datasetId: 'persona' }, snapshot, platform.boss),
    ).rejects.toMatchObject({ status: 409 })
  })
  it('入队失败时回滚任务，避免页面出现永远等待的记录', async () => {
    await expect(
      platform.store.create(input(), snapshot, {
        send: async () => {
          throw new Error('queue down')
        },
      }),
    ).rejects.toThrow()
    expect(await platform.store.list(0, 10)).toHaveLength(0)
  })
  it('已取消的排队任务不执行模型，重复取消保持幂等', async () => {
    const job = await platform.store.create(input(), snapshot, platform.boss)
    expect((await platform.store.cancel(job.id)).status).toBe('cancelled')
    expect((await platform.store.cancel(job.id)).status).toBe('cancelled')
    let calls = 0
    const worker = new EvalWorker(platform.store, async () => {
      calls++
      return summarize('test', [], 0)
    })
    await worker.run(job.id)
    expect(calls).toBe(0)
  })
  it('并发领取及重复投递只执行一次', async () => {
    const job = await platform.store.create(input(), snapshot, platform.boss)
    let calls = 0
    const worker = new EvalWorker(platform.store, async () => {
      calls++
      await delay(50)
      return summarize('test', [], 0)
    })
    await Promise.all([worker.run(job.id), worker.run(job.id)])
    expect(calls).toBe(1)
    expect((await platform.store.get(job.id)).status).toBe('completed')
  })
  it('运行中取消向执行器传递信号并保留取消终态', async () => {
    const job = await platform.store.create(input(), snapshot, platform.boss)
    const worker = new EvalWorker(platform.store, async (_job, signal) => {
      await delay(10_000, undefined, { signal })
      return summarize('test', [], 0)
    })
    const running = worker.run(job.id)
    await delay(50)
    expect((await platform.store.cancel(job.id)).status).toBe('cancelling')
    await running
    expect((await platform.store.get(job.id)).status).toBe('cancelled')
  })
  it('失去心跳的任务标记中断，迟到完成不能覆盖且不自动重跑', async () => {
    const job = await platform.store.create(input(), snapshot, platform.boss)
    await platform.store.claim(job.id)
    await platform.store.db.$client.query(
      "UPDATE eval_jobs SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1",
      [job.id],
    )
    expect(
      await platform.store.recoverInterrupted(new Date(Date.now() - 30_000).toISOString()),
    ).toHaveLength(1)
    await platform.store.finish(job.id, 'completed', null)
    expect((await platform.store.get(job.id)).status).toBe('interrupted')
    expect(await platform.store.claim(job.id)).toBeUndefined()
  })
  it('真实执行内置评测并持久保存结果、评分、工具及模型 Trace', async () => {
    const job = await platform.store.create(input(), snapshot, platform.boss)
    const worker = new EvalWorker(platform.store, (item, signal) =>
      executeJob(item, platform.store, platform.catalog, signal),
    )
    await worker.run(job.id)
    const detail = await platform.store.detail(job.id)
    expect(detail.status).toBe('completed')
    expect(detail.completed).toBe(2)
    expect(detail.trials).toHaveLength(2)
    expect(detail.summary?.totalCases).toBe(2)
    expect(detail.synthetic).toBe(true)
    const fileTrial = detail.trials.find((item) => item.caseId === 'update-package-version')!
    expect(fileTrial.resolved).toBe(true)
    const trace = await platform.store.eventPage(job.id, fileTrial.trialId, 0, 200)
    expect(trace.items.some((item) => item.type === 'model.requested')).toBe(true)
    expect(trace.items.some((item) => item.type === 'tool.completed')).toBe(true)
    expect(trace.items.some((item) => item.type === 'verification.completed')).toBe(true)
    expect(detail.progress).not.toBeNull()
    expect(detail.progress?.events.some((item) => item.type === 'eval.trial.completed')).toBe(true)
    expect(detail.trialProgresses).toHaveLength(2)
    expect(new Set(detail.trialProgresses.map((item) => item.trialId))).toHaveLength(2)
    expect('snapshot' in detail).toBe(false)
  }, 30_000)
  it('Trace 分页不混入其他任务，超大事件明确标记截断', async () => {
    const job = await platform.store.create(input(), snapshot, platform.boss)
    const other = await platform.store.create(input(), snapshot, platform.boss)
    const repository = new PlatformEvalRepository(
      platform.store.db,
      job.id,
      createSecurityServices(),
    )
    const benchmarkRun = await platform.store.primaryBenchmarkRun(job.id)
    for (let sequence = 0; sequence < 3; sequence++) {
      await repository.appendEvent({
        schemaVersion: 1,
        jobId: job.id,
        benchmarkRunId: benchmarkRun.id,
        runId: 'run',
        trialId: 'trial',
        sequence,
        timestamp: new Date().toISOString(),
        source: 'model',
        type: 'model.completed',
        data: sequence === 2 ? 'x'.repeat(140_000) : { value: sequence },
      })
    }
    const page = await platform.store.eventPage(job.id, 'trial', 0, 2)
    expect(page.items).toHaveLength(2)
    expect(page.nextOffset).toBe(2)
    const tail = await platform.store.eventPage(job.id, 'trial', 2, 2)
    expect(tail.items[0]!.data).toMatchObject({ truncated: true })
    expect(tail.nextOffset).toBeNull()
    expect((await platform.store.eventPage(other.id, 'trial', 0, 10)).items).toHaveLength(0)
  })
  it('并发 Trial 的进度事件按 Trial 独立返回，不互相覆盖', async () => {
    const job = await platform.store.create(input(), snapshot, platform.boss)
    const repository = new PlatformEvalRepository(
      platform.store.db,
      job.id,
      createSecurityServices(),
    )
    const benchmarkRun = await platform.store.primaryBenchmarkRun(job.id)
    for (const [trialId, caseId] of [
      ['trial-a', 'case-a'],
      ['trial-b', 'case-b'],
    ] as const) {
      await repository.appendEvent({
        schemaVersion: 1,
        jobId: job.id,
        benchmarkRunId: benchmarkRun.id,
        runId: benchmarkRun.id,
        trialId,
        sequence: 0,
        timestamp: new Date().toISOString(),
        source: 'eval',
        type: 'eval.trial.started',
        data: { caseId },
      })
      await repository.appendEvent({
        schemaVersion: 1,
        jobId: job.id,
        benchmarkRunId: benchmarkRun.id,
        runId: benchmarkRun.id,
        trialId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        source: 'agent',
        type: 'agent.started',
        data: {},
      })
    }
    const progresses = await platform.store.trialProgresses(job.id)
    expect(progresses).toHaveLength(2)
    expect(progresses.map((item) => item.caseId)).toEqual(['case-a', 'case-b'])
    expect(
      progresses.every((item) => item.events.every((event) => event.trialId === item.trialId)),
    ).toBe(true)
  })
  it('未授权真实模型和不存在的任务返回明确错误', async () => {
    await expect(platform.create({ ...input(), modelId: 'configured' })).rejects.toMatchObject({
      code: 'PAID_CONSENT_REQUIRED',
    })
    await expect(platform.store.detail(randomUUID())).rejects.toMatchObject({ status: 404 })
  })
})
