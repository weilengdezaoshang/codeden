import path from 'node:path'
import { PgBoss } from 'pg-boss'
import { CreateJobSchema, PlatformError } from './contracts.js'
import { EvalCatalog } from './catalog.js'
import { connectDatabase } from './database.js'
import { JobStore, QUEUE_NAME, toJobView } from './job-store.js'
import { createHarnessRegistry } from './harness.js'

export async function createPlatform(options: {
  databaseUrl: string
  root: string
  enableRealModels?: boolean
}) {
  const { pool, db } = connectDatabase(options.databaseUrl)
  const store = new JobStore(db)
  const catalog = new EvalCatalog(path.resolve(options.root), options.enableRealModels)
  const harnesses = createHarnessRegistry()
  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    schema: 'codeden_queue',
    connectionTimeoutMillis: 5_000,
  })
  boss.on('error', () => console.error('[eval-platform] 任务队列连接异常'))
  try {
    await boss.start()
    await boss.createQueue(QUEUE_NAME, { retryLimit: 0, expireInSeconds: 900 })
  } catch (error) {
    await boss.stop().catch(() => undefined)
    await pool.end()
    throw error
  }
  return {
    store,
    catalog,
    boss,
    harnesses,
    async create(input: unknown) {
      const parsed = CreateJobSchema.parse(input)
      const snapshot = await catalog.snapshot(parsed)
      return toJobView(await store.create(parsed, snapshot, boss))
    },
    async close() {
      try {
        await boss.stop({ graceful: true, timeout: 5_000 })
      } finally {
        await pool.end()
      }
    },
  }
}
export function platformOptions(env = process.env) {
  if (!env.CODEDEN_EVAL_DATABASE_URL || !env.CODEDEN_EVAL_ROOT) {
    throw new PlatformError(503, 'PLATFORM_NOT_CONFIGURED', '评测平台未配置，请先执行平台初始化。')
  }
  return {
    databaseUrl: env.CODEDEN_EVAL_DATABASE_URL,
    root: env.CODEDEN_EVAL_ROOT,
    enableRealModels: env.CODEDEN_EVAL_REAL_MODELS === '1',
  }
}
export type Platform = Awaited<ReturnType<typeof createPlatform>>
