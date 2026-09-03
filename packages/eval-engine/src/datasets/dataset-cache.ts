import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DatasetManifest } from './dataset-manifest.js'
import { DatasetManifestSchema } from './dataset-manifest.js'

export class DatasetCache {
  constructor(private readonly root: string) {}

  dataPath(manifest: DatasetManifest): string {
    return path.join(this.root, manifest.name, manifest.version, manifest.fileName)
  }

  async readManifest(name: string, version: string): Promise<DatasetManifest | undefined> {
    try {
      const raw = await readFile(path.join(this.root, name, version, 'manifest.json'), 'utf8')
      return DatasetManifestSchema.parse(JSON.parse(raw))
    } catch {
      return undefined
    }
  }

  async writeManifest(manifest: DatasetManifest): Promise<void> {
    const directory = path.dirname(this.dataPath(manifest))
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
}
