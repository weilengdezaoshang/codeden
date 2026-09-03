import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileArtifactManager } from '../../apps/eval-platform/src/platform/artifact-store.js'

describe('测试套件：文件制品管理器', () => {
  it('按完整路由保存并读取 Artifact，同时生成摘要', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-artifacts-'))
    const manager = new FileArtifactManager(root)
    const artifact = await manager.write({
      jobId: 'job-1',
      benchmarkRunId: 'run-1',
      trialId: 'trial-1',
      kind: 'report',
      name: '../official-report.json',
      mediaType: 'application/json',
      source: 'grader',
      content: '{"resolved":true}',
    })

    expect(artifact.uri).toContain('job-1/run-1/trial-1/')
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Buffer.from(await manager.read(artifact)).toString()).toBe('{"resolved":true}')
    expect(await manager.list({ jobId: 'job-1', trialId: 'trial-1' })).toEqual([artifact])
    expect(await manager.list({ jobId: 'job-2' })).toEqual([])
  })
})
