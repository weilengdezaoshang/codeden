import { isEntrypoint } from '@codeden/core/cli/entrypoint.js'
import { createPlatform, platformOptions } from './service.js'
import { EvalWorker } from './worker.js'
import { executeJob } from './executor.js'

export async function startWorker() {
  const platform = await createPlatform(platformOptions())
  const worker = new EvalWorker(platform.store, (job, signal) =>
    executeJob(job, platform.store, platform.catalog, signal, platform.harnesses),
  )
  let stopping = false
  const stop = async () => {
    if (stopping) {
      return
    }
    stopping = true
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await worker.stop()
    await platform.close()
  }
  const onSignal = () => {
    void stop().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    await worker.start(platform.boss)
  } catch (error) {
    await stop()
    throw error
  }
  console.log('[eval-worker] 已就绪，等待评测任务')
  return stop
}
if (isEntrypoint(import.meta.url)) {
  startWorker().catch(() => {
    console.error('[eval-worker] 启动失败，请检查数据库及迁移')
    process.exitCode = 1
  })
}
