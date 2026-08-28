import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DatasetCache } from '../../src/eval/datasets/dataset-cache.js'
import { DatasetFetcher } from '../../src/eval/datasets/dataset-fetcher.js'
import { assertDeclaredDatasetLicense } from '../../src/eval/datasets/dataset-license-policy.js'
import { DatasetSourceSchema } from '../../src/eval/datasets/dataset-source.js'

describe('测试套件：DatasetFetcher', () => {
  it('验证：caches and reuses a verified local dataset', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codeden-dataset-'))
    const sourcePath = path.join(root, 'cases.jsonl')
    const content = '{"id":"case-1"}\n'
    await writeFile(sourcePath, content)
    const sha256 = createHash('sha256').update(content).digest('hex')
    const source = { name: 'fixture', version: '1', localPath: sourcePath, license: 'MIT', sha256 }
    const fetcher = new DatasetFetcher(new DatasetCache(path.join(root, 'cache')))
    const first = await fetcher.fetch(source)
    const second = await fetcher.fetch(source, true)
    expect(second.path).toBe(first.path)
    expect(second.manifest.sha256).toBe(sha256)
  })

  it('验证：rejects undeclared licenses and unsafe cache path segments', () => {
    expect(() => assertDeclaredDatasetLicense('NOASSERTION')).toThrow('explicitly declared')
    expect(() =>
      DatasetSourceSchema.parse({
        name: '../escape',
        version: '1',
        localPath: '/tmp/data.jsonl',
        license: 'MIT',
        sha256: 'a'.repeat(64),
      }),
    ).toThrow()
  })
})
