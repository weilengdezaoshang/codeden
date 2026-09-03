import { z } from 'zod'

/** 评测过程中产生的可下载证据文件类型。 */
export const ArtifactKindSchema = z.enum([
  'agent_answer',
  'patch',
  'stdout',
  'stderr',
  'container_log',
  'report',
  'test_result',
  'other',
])

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>

/** Artifact 的来源组件。 */
export const ArtifactSourceSchema = z.enum(['agent', 'harness', 'grader', 'platform'])

export type ArtifactSource = z.infer<typeof ArtifactSourceSchema>

/**
 * 大体积评测证据的统一引用。
 *
 * RunEvent 只保存 artifactId 和摘要，完整日志、报告和 Patch
 * 通过这个结构关联，避免事件表和实时通道被大文本撑满。
 */
export const ArtifactRefSchema = z
  .object({
    artifactId: z.string().min(1),
    jobId: z.string().min(1),
    benchmarkRunId: z.string().min(1),
    trialId: z.string().min(1),
    kind: ArtifactKindSchema,
    name: z.string().min(1),
    mediaType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    uri: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    source: ArtifactSourceSchema,
    createdAt: z.iso.datetime(),
    truncated: z.boolean().optional(),
  })
  .strict()

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>
