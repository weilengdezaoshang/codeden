import { pgTable, uuid, text, integer, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core'
import type { EvalCase } from '@codeden/eval-engine/domain/eval-case.js'
import type { EvalRun, RunEvidence } from '@codeden/eval-engine/domain/eval-run.js'
import type { TrialResult } from '@codeden/eval-engine/domain/trial-result.js'
import type { RunEvent } from '@codeden/core/events/run-event.js'
import type {
  BenchmarkRunStatus,
  CreateJobInput,
  DatasetId,
  JobStatus,
  JobSummary,
} from './contracts.js'
import type { HarnessType } from './harness.js'

export interface JobSnapshot {
  /** 主评测集目录 ID；多评测集 Job 中对应 datasetId。 */
  datasetId: DatasetId
  datasetName: string
  modelName: string
  benchmarkName: 'native' | 'swebench-lite' | 'swe-polybench' | 'terminal-bench'
  harnessType: HarnessType
  benchmarkVersion?: string
  benchmarkLicense?: string
  benchmarkSha256?: string
  cases: EvalCase[]
  evidence?: RunEvidence
  modelConfigDigest: string
  /** 多评测集 Job 的独立不可变快照。 */
  benchmarkRuns?: BenchmarkRunSnapshot[]
}

/** 一个 BenchmarkRun 的评测集和执行配置快照。 */
export interface BenchmarkRunSnapshot {
  datasetId: DatasetId
  datasetName: string
  benchmarkName: 'native' | 'swebench-lite' | 'swe-polybench' | 'terminal-bench'
  harnessType: HarnessType
  benchmarkVersion?: string
  benchmarkLicense?: string
  benchmarkSha256?: string
  cases: EvalCase[]
  evidence?: RunEvidence
}
export const jobs = pgTable('eval_jobs', {
  id: uuid('id').primaryKey(),
  requestId: uuid('request_id').notNull().unique(),
  input: jsonb('input').$type<CreateJobInput>().notNull(),
  snapshot: jsonb('snapshot').$type<JobSnapshot>().notNull(),
  status: text('status').$type<JobStatus>().notNull(),
  total: integer('total').notNull(),
  completed: integer('completed').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
  message: text('message'),
  summary: jsonb('summary').$type<JobSummary>(),
  run: jsonb('run').$type<EvalRun>(),
})
export const benchmarkRuns = pgTable('eval_benchmark_runs', {
  id: text('id').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id),
  benchmarkType: text('benchmark_type').notNull(),
  harnessType: text('harness_type').notNull(),
  status: text('status').$type<BenchmarkRunStatus>().notNull(),
  total: integer('total').notNull(),
  completed: integer('completed').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
  summary: jsonb('summary').$type<JobSummary>(),
  snapshot: jsonb('snapshot').$type<BenchmarkRunSnapshot>().notNull(),
  run: jsonb('run').$type<EvalRun>(),
})
export const trials = pgTable(
  'eval_trials',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    benchmarkRunId: text('benchmark_run_id')
      .notNull()
      .references(() => benchmarkRuns.id),
    trialId: text('trial_id').notNull(),
    result: jsonb('result').$type<TrialResult>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.benchmarkRunId, table.trialId] })],
)
export const events = pgTable(
  'eval_events',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    benchmarkRunId: text('benchmark_run_id')
      .notNull()
      .references(() => benchmarkRuns.id),
    trialId: text('trial_id').notNull(),
    sequence: integer('sequence').notNull(),
    event: jsonb('event').$type<RunEvent>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.benchmarkRunId, table.trialId, table.sequence] }),
  ],
)
export type StoredJob = typeof jobs.$inferSelect
