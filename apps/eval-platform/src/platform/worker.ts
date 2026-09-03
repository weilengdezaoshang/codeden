import { setTimeout as delay } from 'node:timers/promises'
import type { PgBoss } from 'pg-boss'
import type { StoredJob } from './schema.js'
import type { JobSummary } from './contracts.js'
import { JobStore, QUEUE_NAME } from './job-store.js'

export type JobExecutor = (job: StoredJob, signal: AbortSignal) => Promise<JobSummary>
export class EvalWorker {
  private stopped = false
  private readonly active = new Map<string, AbortController>()
  private recoveryTimer: ReturnType<typeof setInterval> | undefined
  private recovering = false
  constructor(
    private readonly store: JobStore,
    private readonly execute: JobExecutor,
  ) {}

  async start(boss: PgBoss) {
    await this.recover()
    this.recoveryTimer = setInterval(() => {
      void this.recover()
    }, 15_000)
    await boss.work<{ jobId: string }>(
      QUEUE_NAME,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (batch) => {
        for (const item of batch) {
          await this.run(item.data.jobId)
        }
      },
    )
  }
  async stop() {
    this.stopped = true
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer)
    }
    for (const controller of this.active.values()) {
      controller.abort(new Error('WORKER_STOPPED'))
    }
  }
  async run(id: string) {
    if (this.stopped) {
      throw new Error('WORKER_STOPPED')
    }
    const job = await this.store.claim(id)
    if (!job) {
      return
    }
    const controller = new AbortController()
    const monitorStop = new AbortController()
    this.active.set(id, controller)
    const timeoutMs = Number(process.env.CODEDEN_EVAL_JOB_TIMEOUT_MS ?? 30 * 60_000)
    const timeout = setTimeout(() => controller.abort(new Error('JOB_TIMEOUT')), timeoutMs)
    const monitor = this.monitor(id, controller, monitorStop.signal)
    try {
      const summary = await this.execute(job, controller.signal)
      controller.signal.throwIfAborted()
      await this.store.finish(id, 'completed', null, summary)
    } catch (error) {
      const reason: unknown = controller.signal.aborted ? controller.signal.reason : error
      const code = reason instanceof Error ? reason.message : ''
      const detail = reason instanceof Error ? reason.message : String(reason)
      console.error(
        `[eval-worker] 任务 ${id} 执行失败：${reason instanceof Error ? (reason.stack ?? reason.message) : detail}`,
      )
      const status =
        code === 'USER_CANCELLED'
          ? 'cancelled'
          : code === 'WORKER_STOPPED' || code === 'LEASE_LOST'
            ? 'interrupted'
            : 'failed'
      const message =
        code === 'USER_CANCELLED'
          ? '评测已取消，已完成的样本结果已保留。'
          : code.startsWith('VERSION_CHANGED:')
            ? `评测快照发生变化（差异字段：${code.slice('VERSION_CHANGED:'.length)}），请重新创建评测。`
            : code === 'JOB_TIMEOUT'
              ? '评测超过总时限，已停止。'
              : status === 'interrupted'
                ? '评测执行中断，请手动重新创建任务。'
                : `评测执行失败：${detail}`
      await this.store.finish(
        id,
        status,
        message.length > 8_000 ? `…${message.slice(-8_000)}` : message,
      )
    } finally {
      clearTimeout(timeout)
      monitorStop.abort()
      await monitor
      this.active.delete(id)
    }
  }
  private async monitor(id: string, controller: AbortController, stop: AbortSignal) {
    let heartbeatFailures = 0
    while (!stop.aborted) {
      try {
        const status = await this.store.heartbeat(id)
        heartbeatFailures = 0
        if (status === 'cancelling') {
          controller.abort(new Error('USER_CANCELLED'))
          return
        }
        if (!status) {
          heartbeatFailures += 1
        }
        if (heartbeatFailures >= 3) {
          controller.abort(new Error('LEASE_LOST'))
          return
        }
        await delay(500, undefined, { signal: stop })
      } catch {
        if (!stop.aborted) {
          controller.abort(new Error('LEASE_LOST'))
        }
        return
      }
    }
  }
  private async recover() {
    if (this.recovering || this.stopped) {
      return
    }
    this.recovering = true
    try {
      await this.store.recoverInterrupted(new Date(Date.now() - 30_000).toISOString())
    } catch {
      console.error('[eval-worker] 无法检查中断任务')
    } finally {
      this.recovering = false
    }
  }
}
