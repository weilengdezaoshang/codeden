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
    const trialPlans = await tx.execute(
      sql`SELECT version FROM eval_platform_migrations WHERE version = 6`,
    )
    if (trialPlans.rows.length === 0) {
      await tx.execute(sql`CREATE TABLE eval_trial_plans (
        job_id uuid NOT NULL REFERENCES eval_jobs(id),
        benchmark_run_id text NOT NULL REFERENCES eval_benchmark_runs(id),
        case_id text NOT NULL,
        repetition_index integer NOT NULL CHECK (repetition_index >= 1),
        position integer NOT NULL CHECK (position >= 1),
        lifecycle text NOT NULL DEFAULT 'queued' CHECK (lifecycle IN
          ('queued','preparing','running','grading','completed','cancelled','interrupted')),
        verdict text CHECK (verdict IN ('pass','fail','unknown')),
        failure_stage text,
        error_category text,
        failure_detail text,
        trial_id text,
        attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
        statistics_version text NOT NULL DEFAULT '1',
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (job_id, benchmark_run_id, case_id, repetition_index)
      )`)
      await tx.execute(
        sql`CREATE UNIQUE INDEX eval_trial_plans_trial ON eval_trial_plans (job_id, benchmark_run_id, trial_id) WHERE trial_id IS NOT NULL`,
      )
      await tx.execute(
        sql`CREATE INDEX eval_trial_plans_job ON eval_trial_plans (job_id, benchmark_run_id, position)`,
      )
      // 旧 Job 的已完成结果回填为计划行；verdict 与 trial-plan.ts 的推导口径一致。
      await tx.execute(sql`INSERT INTO eval_trial_plans (
        job_id, benchmark_run_id, case_id, repetition_index, position,
        lifecycle, verdict, failure_stage, failure_detail, trial_id, statistics_version
      )
      SELECT
        t.job_id,
        t.benchmark_run_id,
        regexp_replace(t.result->>'caseId', '#[0-9]+$', ''),
        COALESCE((regexp_match(t.result->>'caseId', '#([0-9]+)$'))[1]::int, 1),
        row_number() OVER (PARTITION BY t.job_id, t.benchmark_run_id ORDER BY t.trial_id),
        'completed',
        CASE
          WHEN t.result->'verification'->>'status' = 'passed'
            AND t.result->'infrastructure'->>'status' = 'ok' THEN 'pass'
          WHEN t.result->'infrastructure'->>'status' IS NOT NULL
            AND t.result->'infrastructure'->>'status' <> 'ok' THEN 'unknown'
          WHEN t.result->'execution'->>'status' = 'agent_error' THEN 'unknown'
          WHEN t.result->'verification'->>'status' = 'error' THEN 'unknown'
          WHEN t.result->'execution'->>'status' = 'timeout'
            AND t.result->'verification'->>'status' <> 'failed' THEN 'unknown'
          ELSE 'fail'
        END,
        t.result->'failure'->'diagnosis'->>'stage',
        LEFT(t.result->'failure'->>'message', 2000),
        t.trial_id,
        '1'
      FROM eval_trials t
      ON CONFLICT DO NOTHING`)
      await tx.execute(sql`INSERT INTO eval_platform_migrations(version) VALUES (6)`)
    }
    const executionAttempts = await tx.execute(
      sql`SELECT version FROM eval_platform_migrations WHERE version = 7`,
    )
    if (executionAttempts.rows.length === 0) {
      // 执行尝试账本：每次 TrialResult（含故障与重试）各记一行，成本独立于统计分母。
      await tx.execute(sql`CREATE TABLE eval_execution_attempts (
        job_id uuid NOT NULL REFERENCES eval_jobs(id),
        benchmark_run_id text NOT NULL REFERENCES eval_benchmark_runs(id),
        case_id text NOT NULL,
        repetition_index integer NOT NULL CHECK (repetition_index >= 1),
        attempt_index integer NOT NULL CHECK (attempt_index >= 1),
        trial_id text NOT NULL,
        outcome text NOT NULL CHECK (outcome IN ('pass','fail','unknown')),
        error_category text,
        failure_stage text,
        failure_detail text,
        input_tokens integer,
        output_tokens integer,
        duration_ms integer,
        tool_calls integer,
        model_requests integer,
        tokens_measured boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (job_id, benchmark_run_id, case_id, repetition_index, attempt_index)
      )`)
      await tx.execute(
        sql`CREATE INDEX eval_execution_attempts_job ON eval_execution_attempts (job_id, benchmark_run_id, case_id, repetition_index)`,
      )
      // 回填：既有结果每个记第 1 次尝试；未测得用量记 NULL，不得当 0。
      await tx.execute(sql`INSERT INTO eval_execution_attempts (
        job_id, benchmark_run_id, case_id, repetition_index, attempt_index, trial_id,
        outcome, error_category, failure_stage, failure_detail,
        input_tokens, output_tokens, duration_ms, tool_calls, model_requests, tokens_measured
      )
      SELECT
        t.job_id, t.benchmark_run_id,
        regexp_replace(t.result->>'caseId', '#[0-9]+$', ''),
        COALESCE((regexp_match(t.result->>'caseId', '#([0-9]+)$'))[1]::int, 1),
        1,
        t.trial_id,
        CASE
          WHEN t.result->'verification'->>'status' = 'passed'
            AND t.result->'infrastructure'->>'status' = 'ok' THEN 'pass'
          WHEN t.result->'infrastructure'->>'status' IS NOT NULL
            AND t.result->'infrastructure'->>'status' <> 'ok' THEN 'unknown'
          WHEN t.result->'execution'->>'status' = 'agent_error' THEN 'unknown'
          WHEN t.result->'verification'->>'status' = 'error' THEN 'unknown'
          WHEN t.result->'execution'->>'status' = 'timeout'
            AND t.result->'verification'->>'status' <> 'failed' THEN 'unknown'
          ELSE 'fail'
        END,
        CASE
          WHEN t.result->'infrastructure'->>'status' IS NOT NULL
            AND t.result->'infrastructure'->>'status' <> 'ok' THEN 'env_failure'
          WHEN t.result->'execution'->>'status' = 'agent_error' THEN 'model_error'
          WHEN t.result->'execution'->>'status' = 'timeout'
            AND t.result->'verification'->>'status' <> 'failed' THEN 'timeout'
          WHEN t.result->'verification'->>'status' = 'error' THEN 'unknown'
          WHEN t.result->'verification'->>'status' = 'passed' THEN NULL
          ELSE 'assertion_failed'
        END,
        CASE
          WHEN t.result->'infrastructure'->>'status' IS NOT NULL
            AND t.result->'infrastructure'->>'status' <> 'ok' THEN 'prepare'
          WHEN t.result->'execution'->>'status' = 'agent_error' THEN 'agent'
          WHEN t.result->'verification'->>'status' = 'error' THEN 'grade'
          WHEN t.result->'verification'->>'status' = 'passed' THEN 'grade'
          ELSE 'verify'
        END,
        LEFT(t.result->'failure'->>'message', 2000),
        CASE WHEN COALESCE((t.result->'metrics'->>'modelRequests')::int, 0) > 0
          THEN (t.result->'metrics'->>'inputTokens')::int END,
        CASE WHEN COALESCE((t.result->'metrics'->>'modelRequests')::int, 0) > 0
          THEN (t.result->'metrics'->>'outputTokens')::int END,
        (t.result->'metrics'->>'durationMs')::int,
        (t.result->'metrics'->>'toolCalls')::int,
        (t.result->'metrics'->>'modelRequests')::int,
        COALESCE((t.result->'metrics'->>'modelRequests')::int, 0) > 0
      FROM eval_trials t
      ON CONFLICT DO NOTHING`)
      await tx.execute(sql`INSERT INTO eval_platform_migrations(version) VALUES (7)`)
    }
    const traceReview = await tx.execute(
      sql`SELECT version FROM eval_platform_migrations WHERE version = 8`,
    )
    if (traceReview.rows.length === 0) {
      // M5 闭环：线上 Trace 接收 → 人工审核 → 文本用例草稿 → 发布为不可变数据集版本。
      await tx.execute(sql`CREATE TABLE trace_uploads (
        id text PRIMARY KEY,
        content_digest text NOT NULL,
        title text NOT NULL,
        task_input text NOT NULL,
        agent_answer text,
        status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewing','drafted','discarded')),
        discard_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        reviewed_at timestamptz
      )`)
      await tx.execute(sql`CREATE TABLE trace_case_drafts (
        id uuid PRIMARY KEY,
        trace_id text NOT NULL REFERENCES trace_uploads(id),
        title text NOT NULL,
        task_input text NOT NULL,
        acceptance jsonb NOT NULL,
        target_dataset text NOT NULL,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
        published_version text,
        created_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz
      )`)
      await tx.execute(sql`CREATE TABLE dataset_versions (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        version integer NOT NULL CHECK (version >= 1),
        digest text NOT NULL,
        cases jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (name, version)
      )`)
      await tx.execute(sql`INSERT INTO eval_platform_migrations(version) VALUES (8)`)
    }
  })
}
