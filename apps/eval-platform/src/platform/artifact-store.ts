import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ArtifactManager,
  ArtifactWriteInput,
} from '@codeden/eval-engine/ports/artifact-manager.port.js'
import { ArtifactRefSchema, type ArtifactRef } from '@codeden/eval-engine/domain/artifact.js'

/**
 * 本地 Artifact 存储。
 *
 * 文件路径只由平台生成，name 只进入元数据，不参与路径拼接，
 * 防止第三方报告中的 ../ 内容逃逸出评测根目录。
 */
export class FileArtifactManager implements ArtifactManager {
  constructor(private readonly root: string) {}

  async write(input: ArtifactWriteInput): Promise<ArtifactRef> {
    const artifactId = randomUUID()
    const content =
      typeof input.content === 'string' ? Buffer.from(input.content) : Buffer.from(input.content)
    const relativePath = path.join(
      input.jobId,
      input.benchmarkRunId,
      input.trialId,
      `${artifactId}.bin`,
    )
    const absolutePath = path.join(this.root, relativePath)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, { flag: 'wx' })
    const artifact = ArtifactRefSchema.parse({
      artifactId,
      jobId: input.jobId,
      benchmarkRunId: input.benchmarkRunId,
      trialId: input.trialId,
      kind: input.kind,
      name: input.name,
      mediaType: input.mediaType,
      sizeBytes: content.byteLength,
      uri: relativePath,
      sha256: createHash('sha256').update(content).digest('hex'),
      source: input.source,
      createdAt: new Date().toISOString(),
      ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
    })
    // 元数据和内容分开保存，服务重启后仍可按路由恢复 Artifact 列表。
    await writeFile(`${absolutePath}.json`, JSON.stringify(artifact), { flag: 'wx' })
    return artifact
  }

  async read(artifact: ArtifactRef): Promise<Uint8Array> {
    const absolutePath = this.resolveArtifactPath(artifact)
    const expectedPath = path.join(
      this.root,
      artifact.jobId,
      artifact.benchmarkRunId,
      artifact.trialId,
      `${artifact.artifactId}.bin`,
    )
    if (absolutePath !== path.resolve(expectedPath)) {
      throw new Error(`Artifact route does not match storage path: ${artifact.artifactId}`)
    }
    const content = await readFile(absolutePath)
    const digest = createHash('sha256').update(content).digest('hex')
    if (artifact.sha256 && artifact.sha256 !== digest) {
      throw new Error(`Artifact integrity check failed: ${artifact.artifactId}`)
    }
    return content
  }

  async list(route: {
    jobId: string
    benchmarkRunId?: string
    trialId?: string
  }): Promise<ArtifactRef[]> {
    let files: string[]
    try {
      files = await readdir(this.root, { recursive: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
return []
}
      throw error
    }
    const artifacts: ArtifactRef[] = []
    for (const file of files.filter((item) => item.endsWith('.bin.json'))) {
      let parsed
      try {
        parsed = ArtifactRefSchema.safeParse(
          JSON.parse(await readFile(path.join(this.root, file), 'utf8')),
        )
      } catch {
        continue
      }
      if (!parsed.success) {
continue
}
      const artifact = parsed.data
      if (
        artifact.jobId === route.jobId &&
        (!route.benchmarkRunId || artifact.benchmarkRunId === route.benchmarkRunId) &&
        (!route.trialId || artifact.trialId === route.trialId)
      ) {
        artifacts.push(artifact)
      }
    }
    return artifacts.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  private resolveArtifactPath(artifact: ArtifactRef) {
    const absolutePath = path.resolve(this.root, artifact.uri)
    const root = `${path.resolve(this.root)}${path.sep}`
    if (!absolutePath.startsWith(root)) {
      throw new Error('Artifact path escapes storage root')
    }
    return absolutePath
  }
}
