import { z } from 'zod'
import type { EvalRunSummary } from '@codeden/eval-engine/application/eval-runner.js'
import type { JobStatistics } from './statistics.js'
import type { TrialResult } from '@codeden/eval-engine/domain/trial-result.js'
import type { RunEvent } from '@codeden/core/events/run-event.js'

export const DatasetIdSchema = z.enum([
  'regression',
  'persona',
  'all',
  'swebench-lite',
  'swebench-verified',
  'swe-polybench',
  'terminal-bench',
  'humaneval',
  'reviewed',
])
export type DatasetId = z.infer<typeof DatasetIdSchema>

export const CreateJobSchema = z
  .object({
    requestId: z.uuid(),
    datasetId: DatasetIdSchema,
    /** 可选的并行评测集；datasetId 仍作为兼容的主评测集入口。 */
    datasetIds: z.array(DatasetIdSchema).min(1).max(8).optional(),
    modelId: z.enum(['mock', 'configured']),
    repetitions: z.number().int().min(1).max(20).default(1),
    caseIds: z
      .array(z.string().regex(/^[A-Za-z0-9_.:/-]{1,200}$/u))
      .min(1)
      .max(20)
      .optional(),
    /** 同条件对比实验：复用该基线的冻结快照，仅允许更换被测配置。 */
    baselineJobId: z.uuid().optional(),
    allowPaid: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.datasetIds) {
      return
    }
    if (new Set(input.datasetIds).size !== input.datasetIds.length) {
      context.addIssue({ code: 'custom', path: ['datasetIds'], message: '评测集不能重复。' })
    }
    if (!input.datasetIds.includes(input.datasetId)) {
      context.addIssue({
        code: 'custom',
        path: ['datasetIds'],
        message: 'datasetIds 必须包含 datasetId。',
      })
    }
  })
export type CreateJobInput = z.infer<typeof CreateJobSchema>
export type JobStatus =
  'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export const ACTIVE_STATUSES: JobStatus[] = ['queued', 'running', 'cancelling']
export interface JobSummary extends Omit<EvalRunSummary, 'trials'> {
  /** M2 统计口径：计划行推导，可能与服务端旧摘要字段并存。 */
  statisticsVersion?: string
  unknownCases?: number
  pendingCases?: number
  passShare?: number | null
  validSuccessRate?: number | null
  coverage?: number | null
  incomplete?: boolean
}

/** 一个 Job 中某个评测集执行实例的状态。 */
export type BenchmarkRunStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** Job 下的评测集执行实例视图。 */
export interface BenchmarkRunView {
  /** 评测集执行实例 ID，不等同于 Job ID。 */
  benchmarkRunId: string
  /** 所属平台 Job ID。 */
  jobId: string
  /** 评测集目录 ID。 */
  datasetId: DatasetId
  /** 评测集展示名称。 */
  datasetName: string
  /** 评测集类型，例如 native 或 swebench-lite。 */
  benchmarkType: string
  /** 使用的 Harness 类型。 */
  harnessType: string
  status: BenchmarkRunStatus
  total: number
  completed: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  summary: JobSummary | null
}
export interface JobView {
  id: string
  datasetId: string
  datasetName: string
  modelName: string
  synthetic: boolean
  caseCount: number
  repetitions: number
  status: JobStatus
  total: number
  completed: number
  createdAt: string
  finishedAt: string | null
  message: string | null
  summary: JobSummary | null
}
export interface JobCaseView {
  id: string
  goal: string
  prompt: string
  acceptanceCriteria: string[]
  submissionType: 'files' | 'text'
}
export interface JobDetail extends JobView {
  /** 当前 Job 下的全部评测集执行实例。 */
  benchmarkRuns: BenchmarkRunView[]
  cases: JobCaseView[]
  trials: TrialResult[]
  versions: { dataset: string; agent: string; grader: string; environment: string }
  progress: JobProgress | null
  /** 每个 BenchmarkRun 各自的最新进度；progress 仅为兼容旧客户端保留。 */
  progresses: JobProgress[]
  /** 每个 Trial 各自的最新进度，用于并发执行时独立展示事件时间线。 */
  trialProgresses: JobProgress[]
  /** M2 统计口径：任务级三比率 + 每题 Wilson 区间。 */
  statistics?: JobStatistics
}
export interface JobProgress {
  trialId: string
  caseId: string
  /** 当前事件所属评测集执行实例。 */
  benchmarkRunId?: string
  events: RunEvent[]
}
export interface EventPage {
  items: RunEvent[]
  nextOffset: number | null
  /** 本次结果中最大的 sequence，可作为下一次增量查询游标。 */
  lastSequence: number | null
  /** 存在更多事件时的下一游标。 */
  nextSequence: number | null
}
export interface CatalogCase {
  id: string
  title: string
  repository?: string
  version?: string
}
export interface CatalogDataset {
  id: CreateJobInput['datasetId']
  name: string
  family: string
  description: string
  count: number
  cases: CatalogCase[]
  license?: string
  version?: string
}
export interface CatalogView {
  datasets: CatalogDataset[]
  models: { id: CreateJobInput['modelId']; name: string; synthetic: boolean }[]
}
export class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export function publicError(error: unknown) {
  if (error instanceof PlatformError) {
    return { status: error.status, code: error.code, message: error.message }
  }
  if (error instanceof z.ZodError) {
    return { status: 400, code: 'INVALID_INPUT', message: '请求参数无效，请检查后重试。' }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' }
}
export function parsePage(params: URLSearchParams) {
  return z
    .object({
      offset: z.coerce.number().int().min(0).max(1_000_000),
      limit: z.coerce.number().int().min(1).max(200),
    })
    .parse({ offset: params.get('offset') ?? 0, limit: params.get('limit') ?? 30 })
}

/** 解析事件增量查询游标；未提供时表示从头或按 offset 查询。 */
export function parseEventCursor(params: URLSearchParams) {
  const value = params.get('afterSequence')
  if (value === null) {
    return undefined
  }
  return z.coerce.number().int().nonnegative().parse(value)
}
