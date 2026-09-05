import { randomUUID } from 'node:crypto'
import { contentDigest } from '@codeden/core/content-digest.js'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { PlatformError } from './contracts.js'
import type { Database } from './database.js'
import { datasetVersions, traceCaseDrafts, traceUploads } from './schema.js'

/** 审核验收条件：persona-rubric 的可程序化文本判据（确定性判卷，不调模型）。 */
export const AcceptanceCriteriaSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
        kind: z.enum(['contains', 'not_contains', 'max_chars', 'max_lines']),
        value: z.union([z.string().min(1), z.number().int().positive()]),
        critical: z.boolean().default(false),
        description: z.string().min(1),
      })
      .refine(
        (item) =>
          item.kind === 'max_chars' || item.kind === 'max_lines'
            ? typeof item.value === 'number'
            : typeof item.value === 'string',
        { message: '数值判据需要数字阈值，文本判据需要字符串' },
      ),
  )
  .min(1)
  .max(10)

export type AcceptanceCriteria = z.infer<typeof AcceptanceCriteriaSchema>

export const TraceReceiveSchema = z.object({
  uploadId: z.string().regex(/^[A-Za-z0-9._-]{8,128}$/u),
  title: z.string().min(1).max(200),
  taskInput: z.string().min(1).max(20_000),
  agentAnswer: z.string().max(20_000).optional(),
})

export const TraceReviewSchema = z
  .object({
    action: z.enum(['start', 'discard']),
    reason: z.string().max(500).optional(),
  })
  .refine((value) => value.action !== 'discard' || Boolean(value.reason?.trim()), {
    message: '暂不采用必须填写原因',
  })

export const CaseDraftSchema = z.object({
  traceId: z.string().min(1),
  title: z.string().min(1).max(200),
  taskInput: z.string().min(1).max(20_000),
  criteria: AcceptanceCriteriaSchema,
  targetDataset: z.string().min(1).max(100),
})

export const DEFAULT_REVIEW_DATASET = '人工审核集'

export type TraceRow = typeof traceUploads.$inferSelect
export type CaseDraftRow = typeof traceCaseDrafts.$inferSelect
export type DatasetVersionRow = typeof datasetVersions.$inferSelect

/** 状态机：received → reviewing → drafted | discarded（discard 可来自前两者）。 */
export function nextTraceStatus(
  current: string,
  action: 'start' | 'discard',
): { status: string } | { error: string } {
  if (action === 'start') {
    return current === 'received'
      ? { status: 'reviewing' }
      : { error: `当前状态 ${current} 不允许开始审核。` }
  }
  return current === 'received' || current === 'reviewing'
    ? { status: 'discarded' }
    : { error: `当前状态 ${current} 不允许暂不采用。` }
}

export class TraceStore {
  constructor(readonly db: Database) {}

  /** 幂等接收：同 uploadId + 同内容摘要 → 返回原记录；同 ID 不同内容 → 冲突。 */
  async receive(input: {
    uploadId: string
    title: string
    taskInput: string
    agentAnswer?: string
  }): Promise<{ trace: TraceRow; duplicate: boolean }> {
    const digest = contentDigest({
      title: input.title,
      taskInput: input.taskInput,
      agentAnswer: input.agentAnswer ?? null,
    })
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(traceUploads)
        .where(eq(traceUploads.id, input.uploadId))
      if (existing) {
        if (existing.contentDigest !== digest) {
          throw new PlatformError(409, 'UPLOAD_CONFLICT', '同一上传编号已用于不同内容。')
        }
        return { trace: existing, duplicate: true }
      }
      const [trace] = await tx
        .insert(traceUploads)
        .values({
          id: input.uploadId,
          contentDigest: digest,
          title: input.title,
          taskInput: input.taskInput,
          ...(input.agentAnswer ? { agentAnswer: input.agentAnswer } : {}),
        })
        .returning()
      return { trace: trace!, duplicate: false }
    })
  }

  async list(status?: string): Promise<TraceRow[]> {
    return this.db
      .select()
      .from(traceUploads)
      .where(status ? eq(traceUploads.status, status as TraceRow['status']) : undefined)
      .orderBy(desc(traceUploads.createdAt), desc(traceUploads.id))
  }

  async get(id: string): Promise<TraceRow> {
    const [trace] = await this.db.select().from(traceUploads).where(eq(traceUploads.id, id))
    if (!trace) {
      throw new PlatformError(404, 'TRACE_NOT_FOUND', '上传记录不存在。')
    }
    return trace
  }

  async review(id: string, action: 'start' | 'discard', reason?: string): Promise<TraceRow> {
    const trace = await this.get(id)
    const next = nextTraceStatus(trace.status, action)
    if ('error' in next) {
      throw new PlatformError(409, 'TRACE_STATE', next.error)
    }
    const [updated] = await this.db
      .update(traceUploads)
      .set({
        status: next.status as TraceRow['status'],
        reviewedAt: sql`now()`,
        ...(action === 'discard' ? { discardReason: reason ?? null } : {}),
      })
      .where(and(eq(traceUploads.id, id), eq(traceUploads.status, trace.status)))
      .returning()
    if (!updated) {
      throw new PlatformError(409, 'TRACE_STATE', '状态已被并发修改，请刷新后重试。')
    }
    return updated
  }

  async createDraft(input: {
    traceId: string
    title: string
    taskInput: string
    criteria: AcceptanceCriteria
    targetDataset: string
  }): Promise<CaseDraftRow> {
    const trace = await this.get(input.traceId)
    if (trace.status === 'drafted') {
      throw new PlatformError(409, 'TRACE_STATE', '该记录已整理入库。')
    }
    if (trace.status === 'discarded') {
      throw new PlatformError(409, 'TRACE_STATE', '暂不采用的记录不能整理用例。')
    }
    return this.db.transaction(async (tx) => {
      if (trace.status === 'received') {
        await tx
          .update(traceUploads)
          .set({ status: 'reviewing', reviewedAt: sql`now()` })
          .where(and(eq(traceUploads.id, input.traceId), eq(traceUploads.status, 'received')))
      }
      const [draft] = await tx
        .insert(traceCaseDrafts)
        .values({
          id: randomUUID(),
          traceId: input.traceId,
          title: input.title,
          taskInput: input.taskInput,
          acceptance: input.criteria,
          targetDataset: input.targetDataset || DEFAULT_REVIEW_DATASET,
        })
        .returning()
      return draft!
    })
  }

  async getDraft(id: string): Promise<CaseDraftRow> {
    const [draft] = await this.db.select().from(traceCaseDrafts).where(eq(traceCaseDrafts.id, id))
    if (!draft) {
      throw new PlatformError(404, 'DRAFT_NOT_FOUND', '用例草稿不存在。')
    }
    return draft
  }

  /** 发布：用例进入目标数据集的新不可变版本；同批发布全部已发布用例。 */
  async publishDraft(id: string): Promise<{ draft: CaseDraftRow; version: DatasetVersionRow }> {
    return this.db.transaction(async (tx) => {
      const [draft] = await tx.select().from(traceCaseDrafts).where(eq(traceCaseDrafts.id, id))
      if (!draft) {
        throw new PlatformError(404, 'DRAFT_NOT_FOUND', '用例草稿不存在。')
      }
      if (draft.status === 'published') {
        throw new PlatformError(409, 'DRAFT_STATE', '该草稿已发布入库。')
      }
      const published = await tx
        .select()
        .from(traceCaseDrafts)
        .where(
          and(
            eq(traceCaseDrafts.targetDataset, draft.targetDataset),
            eq(traceCaseDrafts.status, 'published'),
          ),
        )
      const cases = [...published, draft]
      const versionRows = await tx
        .select({ maxVersion: sql<number>`COALESCE(MAX(${datasetVersions.version}), 0)` })
        .from(datasetVersions)
        .where(eq(datasetVersions.name, draft.targetDataset))
      const version = Number(versionRows[0]?.maxVersion ?? 0) + 1
      const digest = contentDigest(cases)
      const [versionRow] = await tx
        .insert(datasetVersions)
        .values({
          id: randomUUID(),
          name: draft.targetDataset,
          version,
          digest,
          cases,
        })
        .returning()
      const [updatedDraft] = await tx
        .update(traceCaseDrafts)
        .set({ status: 'published', publishedVersion: `v${version}`, publishedAt: sql`now()` })
        .where(eq(traceCaseDrafts.id, id))
        .returning()
      await tx
        .update(traceUploads)
        .set({ status: 'drafted', reviewedAt: sql`now()` })
        .where(and(eq(traceUploads.id, draft.traceId), eq(traceUploads.status, 'reviewing')))
      return { draft: updatedDraft!, version: versionRow! }
    })
  }

  /** 最近已发布的数据集版本（catalog 的"人工审核集"数据源）。 */
  async latestDatasetVersion(name = DEFAULT_REVIEW_DATASET): Promise<DatasetVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(datasetVersions)
      .where(eq(datasetVersions.name, name))
      .orderBy(desc(datasetVersions.version))
      .limit(1)
    return row ?? null
  }
}
