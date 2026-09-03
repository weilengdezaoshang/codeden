import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { DatasetManifest } from './dataset-manifest.js'
import type { DatasetSource } from './dataset-source.js'
import { DatasetCache } from './dataset-cache.js'

export class DatasetFetcher {
  constructor(private readonly cache: DatasetCache) {}

  async fetch(
    source: DatasetSource,
    offline = false,
  ): Promise<{ path: string; manifest: DatasetManifest }> {
    const cached = await this.cache.readManifest(source.name, source.version)
    if (
      cached &&
      cached.sha256.toLowerCase() === source.sha256.toLowerCase() &&
      cached.license === source.license
    ) {
      const cachedPath = this.cache.dataPath(cached)
      await verifyChecksum(cachedPath, source.sha256)
      return { path: cachedPath, manifest: cached }
    }
    if (offline || (!source.url && !source.localPath)) {
      throw new CodeDenError({
        code: ErrorCodes.INVALID_INPUT,
        category: 'validation',
        message: `Dataset is not available offline: ${source.name}@${source.version}`,
        retryable: false,
      })
    }
    const fileName = source.localPath
      ? path.basename(source.localPath)
      : path.basename(new URL(source.url as string).pathname)
    const destination = this.cache.dataPath({
      ...source,
      fileName,
      fetchedAt: new Date().toISOString(),
    })
    await mkdir(path.dirname(destination), { recursive: true })
    if (source.localPath) {
      await copyFile(source.localPath, destination)
    } else {
      const response = await fetch(source.url as string)
      if (!response.ok) {
        throw new Error(`Dataset download failed: ${response.status}`)
      }
      await writeFile(destination, Buffer.from(await response.arrayBuffer()))
    }
    await verifyChecksum(destination, source.sha256)
    const manifest: DatasetManifest = {
      name: source.name,
      version: source.version,
      license: source.license,
      sha256: source.sha256,
      fetchedAt: new Date().toISOString(),
      fileName,
    }
    await this.cache.writeManifest(manifest)
    return { path: destination, manifest }
  }
}

async function verifyChecksum(filePath: string, expected: string): Promise<void> {
  const digest = createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
  if (digest.toLowerCase() !== expected.toLowerCase()) {
    throw new CodeDenError({
      code: ErrorCodes.INVALID_INPUT,
      category: 'validation',
      message: `Dataset checksum mismatch: ${filePath}`,
      retryable: false,
    })
  }
}
