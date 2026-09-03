import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentDigest } from '@codeden/core/content-digest.js'
import { EvalCatalog } from '../../apps/eval-platform/src/platform/catalog.js'
import { normalizeSnapshotForExecution } from '../../apps/eval-platform/src/platform/executor.js'
import type { JobSnapshot } from '../../apps/eval-platform/src/platform/schema.js'

describe('评测平台快照兼容', () => {
  it('旧 SWE-bench Job 缺少 harnessType 时与当前快照保持相同摘要', async () => {
    const catalog = new EvalCatalog(process.cwd())
    const snapshot = await catalog.snapshot({
      requestId: crypto.randomUUID(),
      datasetId: 'swebench-lite',
      modelId: 'mock',
      repetitions: 1,
      caseIds: ['astropy__astropy-12907'],
      allowPaid: false,
    })
    const { harnessType: _harnessType, ...legacy } = snapshot
    const normalized = normalizeSnapshotForExecution(legacy as JobSnapshot)

    expect(normalized.harnessType).toBe('swebench-official')
    expect(contentDigest(normalized)).toBe(contentDigest(snapshot))
  })

  it('正式页面启动脚本强制 Web 与 Worker 使用源码导出条件', async () => {
    const script = await readFile(path.resolve('scripts/start-eval-platform.mjs'), 'utf8')
    expect(script).toContain("const sourceConditions = '--conditions=codeden-source'")
    expect(script).toContain('NODE_OPTIONS: [env.NODE_OPTIONS, sourceConditions]')
  })
})
