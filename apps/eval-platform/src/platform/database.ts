import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'

export function connectDatabase(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 6,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  })
  pool.on('error', () => console.error('[eval-platform] 数据库连接中断'))
  return { pool, db: drizzle(pool) }
}
export type Database = ReturnType<typeof connectDatabase>['db']

/** 显式迁移入口。版本表与 PostgreSQL 事务锁让重复/并行执行保持安全。 */
export async function migrateDatabase(db: Database) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(70130901)`)
    await tx.execute(
      sql`CREATE TABLE IF NOT EXISTS eval_platform_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    )
    const applied = await tx.execute(
      sql`SELECT version FROM eval_platform_migrations WHERE version = 1`,
    )
    if (applied.rows.length === 0) {
      await tx.execute(sql`CREATE TABLE eval_jobs (
        id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE, input jsonb NOT NULL, snapshot jsonb NOT NULL,
        status text NOT NULL CHECK (status IN ('queued','running','cancelling','completed','failed','cancelled','interrupted')),
        total integer NOT NULL CHECK (total > 0), completed integer NOT NULL DEFAULT 0 CHECK (completed >= 0 AND completed <= total),
        created_at timestamptz NOT NULL DEFAULT now(), heartbeat_at timestamptz, finished_at timestamptz,
        message text, summary jsonb, run jsonb)`)
      await tx.execute(sql`CREATE INDEX eval_jobs_created ON eval_jobs (created_at DESC, id DESC)`)
      await tx.execute(
        sql`CREATE TABLE eval_trials (job_id uuid NOT NULL REFERENCES eval_jobs(id), trial_id text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(job_id, trial_id))`,
      )
      await tx.execute(
        sql`CREATE TABLE eval_events (job_id uuid NOT NULL REFERENCES eval_jobs(id), trial_id text NOT NULL, sequence integer NOT NULL CHECK(sequence >= 0), event jsonb NOT NULL, PRIMARY KEY(job_id, trial_id, sequence))`,
      )
      await tx.execute(sql`INSERT INTO eval_platform_migrations(version) VALUES (1)`)
    }
    const benchmarkRuns = await tx.execute(
      sql`SELECT version FROM eval_platform_migrations WHERE version = 2`,
    )
    if (benchmarkRuns.rows.length === 0) {
      await tx.execute(sql`CREATE TABLE IF NOT EXISTS eval_benchmark_runs (
        id text PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES eval_jobs(id),
        benchmark_type text NOT NULL,
        harness_type text NOT NULL,
        status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','interrupted')),
        total integer NOT NULL CHECK (total > 0),
        completed integer NOT NULL DEFAULT 0 CHECK (completed >= 0 AND completed <= total),
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        finished_at timestamptz,
        summary jsonb
      )`)
      await tx.execute(
        sql`CREATE INDEX IF NOT EXISTS eval_benchmark_runs_job ON eval_benchmark_runs (job_id, created_at, id)`,
      )
      // 为版本 1 中已经存在的 Job 补建唯一的主 BenchmarkRun，保证升级后旧任务仍可执行。
      await tx.execute(sql`INSERT INTO eval_benchmark_runs (
        id, job_id, benchmark_type, harness_type, status, total, completed, created_at, finished_at
      )
      SELECT
        'legacy:' || job.id::text,
        job.id,
        COALESCE(job.snapshot->>'benchmarkName', 'native'),
        COALESCE(
          job.snapshot->>'harnessType',
          CASE WHEN job.snapshot->>'benchmarkName' = 'swebench-lite'
            THEN 'swebench-official'
            ELSE 'native'
          END
        ),
        CASE
          WHEN job.status = 'cancelling' THEN 'running'
          ELSE job.status
        END,
        job.total,
        job.completed,
        job.created_at,
        job.finished_at
      FROM eval_jobs job
      WHERE NOT EXISTS (
        SELECT 1 FROM eval_benchmark_runs existing
        WHERE existing.job_id = job.id
      )`)
      await tx.execute(sql`INSERT INTO eval_platform_migrations(version) VALUES (2)`)
    }
    const routedEvents = await tx.execute(
      sql`SELECT version FROM eval_platform_migrations WHERE version = 3`,
    )
    if (routedEvents.rows.length === 0) {
      await tx.execute(sql`ALTER TABLE eval_trials ADD COLUMN IF NOT EXISTS benchmark_run_id text`)
      await tx.execute(sql`ALTER TABLE eval_events ADD COLUMN IF NOT EXISTS benchmark_run_id text`)
      await tx.execute(sql`UPDATE eval_trials trial
        SET benchmark_run_id = runs.id
        FROM eval_benchmark_runs runs
        WHERE trial.job_id = runs.job_id
          AND trial.benchmark_run_id IS NULL`)
      await tx.execute(sql`UPDATE eval_events event
        SET benchmark_run_id = runs.id
        FROM eval_benchmark_runs runs
        WHERE event.job_id = runs.job_id
          AND event.benchmark_run_id IS NULL`)
      await tx.execute(sql`ALTER TABLE eval_trials ALTER COLUMN benchmark_run_id SET NOT NULL`)
      await tx.execute(sql`ALTER TABLE eval_events ALTER COLUMN benchmark_run_id SET NOT NULL`)
      await tx.execute(sql`ALTER TABLE eval_trials DROP CONSTRAINT IF EXISTS eval_trials_pkey`)
      await tx.execute(
        sql`ALTER TABLE eval_trials ADD CONSTRAINT eval_trials_pkey PRIMARY KEY (job_id, benchmark_run_id, trial_id)`,
      )
      await tx.execute(sql`ALTER TABLE eval_events DROP CONSTRAINT IF EXISTS eval_events_pkey`)
      await tx.execute(
        sql`ALTER TABLE eval_events ADD CONSTRAINT eval_events_pkey PRIMARY KEY (job_id, benchmark_run_id, trial_id, sequence)`,
      )
      await tx.execute(sql`ALTER TABLE eval_trials ADD CONSTRAINT eval_trials_benchmark_run_fk
        FOREIGN KEY (benchmark_run_id) REFERENCES eval_benchmark_runs(id)`)
      await tx.execute(sql`ALTER TABLE eval_events ADD CONSTRAINT eval_events_benchmark_run_fk
        FOREIGN KEY (benchmark_run_id) REFERENCES eval_benchmark_runs(id)`)
      await tx.execute(sql`CREATE INDEX IF NOT EXISTS eval_events_route
        ON eval_events (job_id, benchmark_run_id, trial_id, sequence)`)
      await tx.execute(sql`INSERT INTO eval_platform_migrations(version) VALUES (3)`)
    }
    const benchmarkSnapshots = await tx.execute(
      sql`SELECT version FROM eval_platform_migrations WHERE version = 4`,
    )
    if (benchmarkSnapshots.rows.length === 0) {
      await tx.execute(sql`ALTER TABLE eval_benchmark_runs ADD COLUMN IF NOT EXISTS snapshot jsonb`)
      await tx.execute(sql`UPDATE eval_benchmark_runs run
        SET snapshot = jsonb_set(
          job.snapshot,
          '{datasetId}',
          to_jsonb(job.input->>'datasetId'),
          true
        )
        FROM eval_jobs job
        WHERE run.job_id = job.id
          AND run.snapshot IS NULL`)
      await tx.execute(sql`ALTER TABLE eval_benchmark_runs ALTER COLUMN snapshot SET NOT NULL`)
      await tx.execute(sql`INSERT INTO eval_platform_migrations(version) VALUES (4)`)
    }
    const benchmarkRunsHaveRun = await tx.execute(
      sql`SELECT version FROM eval_platform_migrations WHERE version = 5`,
    )
    if (benchmarkRunsHaveRun.rows.length === 0) {
      await tx.execute(sql`ALTER TABLE eval_benchmark_runs ADD COLUMN IF NOT EXISTS run jsonb`)
      await tx.execute(sql`INSERT INTO eval_platform_migrations(version) VALUES (5)`)
    }
  })
}
