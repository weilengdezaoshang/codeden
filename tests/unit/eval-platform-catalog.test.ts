import { describe, expect, it } from 'vitest'
import { EvalCatalog } from '../../apps/eval-platform/src/platform/catalog.js'

describe('评测平台目录', () => {
  it('列出开源 SWE-bench Lite 及具体题目', async () => {
    const catalog = await new EvalCatalog(process.cwd()).view()
    const dataset = catalog.datasets.find((item) => item.id === 'swebench-lite')
    expect(dataset?.family).toBe('开源评测集')
    expect(dataset?.count).toBeGreaterThan(0)
    expect(dataset?.cases[0]).toMatchObject({
      id: 'astropy__astropy-12907',
      repository: 'astropy/astropy',
    })
  })

  it('按选择的具体题目构建 SWE-bench Job 快照', async () => {
    const catalog = new EvalCatalog(process.cwd())
    const view = await catalog.view()
    const caseId = view.datasets.find((item) => item.id === 'swebench-lite')!.cases[0]!.id
    const snapshot = await catalog.snapshot({
      requestId: crypto.randomUUID(),
      datasetId: 'swebench-lite',
      modelId: 'mock',
      repetitions: 1,
      caseIds: [caseId],
      allowPaid: false,
    })
    expect(snapshot.benchmarkName).toBe('swebench-lite')
    expect(snapshot.harnessType).toBe('swebench-official')
    expect(snapshot.cases.map((item) => item.id)).toEqual([caseId])
  })

  it('为多个评测集生成相互独立的 BenchmarkRun 快照', async () => {
    const snapshot = await new EvalCatalog(process.cwd()).snapshot({
      requestId: crypto.randomUUID(),
      datasetId: 'regression',
      datasetIds: ['regression', 'persona'],
      modelId: 'mock',
      repetitions: 1,
      allowPaid: false,
    })
    expect(snapshot.benchmarkRuns).toHaveLength(2)
    expect(snapshot.benchmarkRuns?.map((item) => item.datasetId)).toEqual(['regression', 'persona'])
    expect(snapshot.benchmarkRuns?.every((item) => item.cases.length === 1)).toBe(true)
  })

  it('datasetIds 只有一个值时仍保留 caseIds 筛选', async () => {
    const catalog = new EvalCatalog(process.cwd())
    const snapshot = await catalog.snapshot({
      requestId: crypto.randomUUID(),
      datasetId: 'regression',
      datasetIds: ['regression'],
      modelId: 'mock',
      repetitions: 1,
      caseIds: ['update-package-version'],
      allowPaid: false,
    })
    expect(snapshot.cases.map((item) => item.id)).toEqual(['update-package-version'])
    expect(snapshot.benchmarkRuns).toBeUndefined()
  })
})
