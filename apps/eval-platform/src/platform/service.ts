import path from 'node:path'
import { PgBoss } from 'pg-boss'
import { CreateJobSchema, PlatformError, type CreateJobInput } from './contracts.js'
import { EvalCatalog } from './catalog.js'
import { connectDatabase } from './database.js'
import { JobStore, QUEUE_NAME, toJobView } from './job-store.js'
import { TraceStore } from './trace-store.js'
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
  const traces = new TraceStore(db)
  // 人工审核集数据源：catalog 的 reviewed 数据集读取最近发布的不可变版本。
  catalog.setReviewedDatasetSource({
    async latest() {
      const row = await traces.latestDatasetVersion()
      if (!row) {
        return null
      }
      const cases = (
        row.cases as {
          id: string
          title: string
          taskInput: string
          acceptance: {
            id: string
            kind: 'contains' | 'not_contains' | 'max_chars' | 'max_lines'
            value: string | number
            critical: boolean
            description: string
          }[]
        }[]
      ).map((draft) => ({
        id: `review-${draft.id.replace(/-/gu, '').slice(0, 12)}`,
        title: draft.title,
        taskInput: draft.taskInput,
        criteria: draft.acceptance,
      }))
      return { name: row.name, version: row.version, digest: row.digest, cases }
    },
  })
  return {
    store,
    catalog,
    boss,
    harnesses,
    traces,
    async create(input: unknown) {
      const parsed = CreateJobSchema.parse(input)
      if (parsed.baselineJobId) {
        // 对比实验：复用基线冻结快照（题目/环境/判卷），仅被测配置（modelId）可与基线不同。
        const baseline = await store.get(parsed.baselineJobId)
        if (parsed.datasetId !== baseline.input.datasetId) {
          throw new PlatformError(400, 'BASELINE_MISMATCH', '对比实验必须使用与基线相同的评测集。')
        }
        if (parsed.repetitions !== baseline.input.repetitions) {
          throw new PlatformError(
            400,
            'BASELINE_MISMATCH',
            `对比实验的每题次数必须与基线一致（${baseline.input.repetitions} 次）。`,
          )
        }
        const normalized: CreateJobInput = {
          ...parsed,
          datasetIds: baseline.input.datasetIds,
          caseIds: undefined,
        }
        return toJobView(await store.create(normalized, baseline.snapshot, boss))
      }
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
