import type { ArtifactKind, ArtifactRef, ArtifactSource } from '../domain/artifact.js'

/** Artifact 写入请求。调用方负责在写入前完成脱敏。 */
export interface ArtifactWriteInput {
  jobId: string
  benchmarkRunId: string
  trialId: string
  kind: ArtifactKind
  name: string
  mediaType: string
  source: ArtifactSource
  content: string | Uint8Array
  truncated?: boolean
}

/** 统一评测证据文件存储端口。 */
export interface ArtifactManager {
  write(input: ArtifactWriteInput): Promise<ArtifactRef>
  read(artifact: ArtifactRef): Promise<Uint8Array>
  list(route: { jobId: string; benchmarkRunId?: string; trialId?: string }): Promise<ArtifactRef[]>
}
