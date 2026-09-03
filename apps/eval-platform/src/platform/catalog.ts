import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ConfigLoader } from '@codeden/core/config/config-loader.js'
import { contentDigest } from '@codeden/core/content-digest.js'
import { createSecurityServices } from '@codeden/core/security/security-services.js'
import { ProviderRegistry } from '@codeden/agent-runtime/models/provider-registry.js'
import { ModelProviderFactory } from '@codeden/agent-runtime/models/model-provider-factory.js'
import { createModelProvider } from '@codeden/agent-runtime/models/create-model-provider.js'
import { finalText } from '@codeden/agent-runtime/models/mock-model-provider.js'
import { createEvalMockProvider } from '@codeden/eval-engine/adapters/agents/eval-mock-provider.js'
import { loadNativeCaseFile } from '@codeden/eval-engine/adapters/benchmarks/native/native-case-loader.js'
import { SweBenchAdapter } from '@codeden/eval-engine/adapters/benchmarks/swebench/swebench.adapter.js'
import { loadSweBenchRecords } from '@codeden/eval-engine/adapters/benchmarks/swebench/swebench.loader.js'
import { SwePolyBenchAdapter } from '@codeden/eval-engine/adapters/benchmarks/swepolybench/swepolybench.adapter.js'
import { loadSwePolyBenchRecords } from '@codeden/eval-engine/adapters/benchmarks/swepolybench/swepolybench.loader.js'
import { TerminalBenchAdapter } from '@codeden/eval-engine/adapters/benchmarks/terminalbench/terminalbench.adapter.js'
import { loadTerminalBenchTasks } from '@codeden/eval-engine/adapters/benchmarks/terminalbench/terminalbench.loader.js'
import { createRunEvidence } from '@codeden/eval-engine/optimization/run-evidence.js'
import type { EvalCase } from '@codeden/eval-engine/domain/eval-case.js'
import type { CreateJobInput, CatalogDataset, CatalogView } from './contracts.js'
import { PlatformError } from './contracts.js'
import type { BenchmarkRunSnapshot, JobSnapshot } from './schema.js'

const nativeDatasets: CatalogDataset[] = [
  {
    id: 'regression',
    family: '内置评测集',
    name: '文件修改回归',
    description: '版本与文件结果',
    count: 1,
    cases: [{ id: 'update-package-version', title: '修改 package.json 版本' }],
  },
  {
    id: 'persona',
    family: '内置评测集',
    name: '人格与 Token',
    description: '表达与预算',
    count: 1,
    cases: [{ id: 'persona-concise', title: '简洁完成说明' }],
  },
  {
    id: 'all',
    family: '内置评测集',
    name: '内置完整回归',
    description: '全部内置用例',
    count: 2,
    cases: [
      { id: 'update-package-version', title: '修改 package.json 版本' },
      { id: 'persona-concise', title: '简洁完成说明' },
    ],
  },
]
const sweBenchVersion = 'SWE-bench_Lite-test'
const sweBenchLicense = 'mit'
const swePolyBenchVersion = process.env.CODEDEN_SWE_POLYBENCH_VERSION ?? '1.1'
const swePolyBenchLicense = 'cc-by-nc-4.0'
const terminalBenchVersion = process.env.CODEDEN_TERMINAL_BENCH_VERSION ?? '2.0'
const terminalBenchLicense = 'apache-2.0'

export class EvalCatalog {
  private openSourceDatasetPromise: Promise<CatalogDataset> | undefined
  private swePolyBenchDatasetPromise: Promise<CatalogDataset> | undefined
  private terminalBenchDatasetPromise: Promise<CatalogDataset> | undefined

  constructor(
    readonly root: string,
    readonly enableRealModels = false,
  ) {}

  async view(): Promise<CatalogView> {
    const models: CatalogView['models'] = [{ id: 'mock', name: 'Mock', synthetic: true }]
    if (this.enableRealModels) {
      try {
        const { config } = await this.model('configured')
        models.push({
          id: 'configured',
          name: `${config!.agent.defaultProvider} / ${config!.agent.defaultModel ?? config!.providers[config!.agent.defaultProvider]!.defaultModel}`,
          synthetic: false,
        })
      } catch {
        // Catalog remains usable when only the mock provider is configured.
      }
    }
    return {
      datasets: [
        ...nativeDatasets,
        await this.openSourceDataset(),
        await this.swePolyBenchDataset(),
        await this.terminalBenchDataset(),
      ],
      models,
    }
  }

  async snapshot(input: CreateJobInput): Promise<JobSnapshot> {
    const datasetIds = input.datasetIds ?? [input.datasetId]
    if (datasetIds.length > 1 && input.caseIds) {
      throw new PlatformError(
        400,
        'CASES_MULTI_DATASET_UNSUPPORTED',
        '并行选择多个评测集时暂不支持指定题目。',
      )
    }
    const snapshots = await Promise.all(
      datasetIds.map((datasetId) =>
        this.snapshotSingle({
          ...input,
          datasetId,
          datasetIds: undefined,
          caseIds: datasetIds.length > 1 ? undefined : input.caseIds,
        }),
      ),
    )
    const primary = snapshots[0]!
    return {
      ...primary,
      datasetName: snapshots.map((snapshot) => snapshot.datasetName).join(' + '),
      cases: snapshots.flatMap((snapshot) => snapshot.cases),
      ...(snapshots.length > 1 ? { benchmarkRuns: snapshots.map(toBenchmarkRunSnapshot) } : {}),
    }
  }

  private async snapshotSingle(input: CreateJobInput): Promise<JobSnapshot> {
    if (input.modelId === 'configured' && !input.allowPaid) {
      throw new PlatformError(400, 'PAID_CONSENT_REQUIRED', '请先确认本次评测会消耗真实模型额度。')
    }
    const catalog = await this.view()
    const dataset = catalog.datasets.find((item) => item.id === input.datasetId)
    if (!dataset) {
      throw new PlatformError(400, 'DATASET_NOT_FOUND', '评测集不存在。')
    }
    if (
      ['swebench-lite', 'swe-polybench', 'terminal-bench'].includes(input.datasetId) &&
      dataset.count === 0
    ) {
      throw new PlatformError(400, 'DATASET_NOT_IMPORTED', `${dataset.name} 尚未导入。`)
    }
    const model = await this.model(input.modelId)
    const selectedIds = input.caseIds
    let cases: EvalCase[]
    let benchmarkName: JobSnapshot['benchmarkName'] = 'native'

    if (input.datasetId === 'swebench-lite') {
      const sourcePath = this.sweBenchPath()
      const records = await loadSweBenchRecords(sourcePath)
      const ids = selectedIds ?? records.slice(0, 1).map((item) => item.instance_id)
      assertSelectedIds(
        ids,
        records.map((item) => item.instance_id),
      )
      const digest = await fileSha256(sourcePath)
      const benchmark = new SweBenchAdapter({
        datasetVersion: sweBenchVersion,
        license: sweBenchLicense,
        sha256: digest,
        verificationMode: 'host-opt-in',
        resolveVerificationCommand: (_record, tests) => ({
          command: 'python',
          args: ['-m', 'pytest', '-q', ...tests],
        }),
      })
      const loaded = await collect(benchmark.load({ kind: 'file', path: sourcePath }))
      cases = loaded.filter((item) => ids.includes(item.id))
      benchmarkName = 'swebench-lite'
    } else if (input.datasetId === 'swe-polybench') {
      const sourcePath = this.swePolyBenchPath()
      const records = await loadSwePolyBenchRecords(sourcePath)
      const ids = selectedIds ?? records.slice(0, 1).map((item) => item.instance_id)
      assertSelectedIds(
        ids,
        records.map((item) => item.instance_id),
      )
      const digest = await fileSha256(sourcePath)
      const benchmark = new SwePolyBenchAdapter({
        datasetVersion: swePolyBenchVersion,
        license: swePolyBenchLicense,
        sha256: digest,
        verificationMode: 'host-opt-in',
        imageFor: (record) =>
          `ghcr.io/timesler/swe-polybench.eval.x86_64.${record.instance_id}:v${swePolyBenchVersion}`,
      })
      const loaded = await collect(benchmark.load({ kind: 'file', path: sourcePath }))
      cases = loaded.filter((item) => ids.includes(item.id))
      benchmarkName = 'swe-polybench'
    } else if (input.datasetId === 'terminal-bench') {
      const sourcePath = this.terminalBenchPath()
      const tasks = await loadTerminalBenchTasks(sourcePath)
      const ids = selectedIds ?? tasks.slice(0, 1).map((item) => item.id)
      assertSelectedIds(
        ids,
        tasks.map((item) => item.id),
      )
      const digest = await directorySha256(sourcePath)
      const benchmark = new TerminalBenchAdapter({
        datasetVersion: terminalBenchVersion,
        license: terminalBenchLicense,
        sha256: digest,
      })
      const loaded = await collect(benchmark.load({ kind: 'directory', path: sourcePath }))
      cases = loaded.filter((item) => ids.includes(item.id))
      benchmarkName = 'terminal-bench'
    } else {
      const names =
        input.datasetId === 'regression'
          ? ['update-package-version']
          : input.datasetId === 'persona'
            ? ['persona-concise']
            : ['update-package-version', 'persona-concise']
      const loaded = await Promise.all(
        names.map((name) =>
          loadNativeCaseFile(path.join(this.root, 'evals/cases/regression', `${name}.yaml`)),
        ),
      )
      assertSelectedIds(
        selectedIds,
        loaded.map((item) => item.id),
      )
      cases = selectedIds ? loaded.filter((item) => selectedIds.includes(item.id)) : loaded
    }
    if (cases.length === 0) {
      throw new PlatformError(400, 'CASES_REQUIRED', '至少选择一道题目。')
    }
    cases = repeatCases(cases, input.repetitions)
    const extendedBenchmark = ['swebench-lite', 'swe-polybench', 'terminal-bench'].includes(
      benchmarkName,
    )
    const maxTimeoutMs = extendedBenchmark ? 300_000 : 60_000
    const maxTurns = extendedBenchmark ? 30 : 16
    const maxToolCalls = extendedBenchmark ? 80 : 32
    if (
      cases.some(
        (item) =>
          item.limits.timeoutMs > maxTimeoutMs ||
          item.limits.maxTurns > maxTurns ||
          item.limits.maxToolCalls > maxToolCalls,
      )
    ) {
      throw new PlatformError(400, 'DATASET_LIMIT', '评测集的执行上限超过当前平台限制。')
    }
    return {
      datasetName: dataset.name,
      datasetId: input.datasetId,
      modelName: catalog.models.find((item) => item.id === input.modelId)?.name ?? input.modelId,
      cases,
      benchmarkName,
      harnessType:
        benchmarkName === 'swebench-lite'
          ? 'swebench-official'
          : benchmarkName === 'swe-polybench'
            ? 'swe-polybench-docker'
            : benchmarkName === 'terminal-bench'
              ? 'terminal-bench-docker'
              : 'native',
      ...(benchmarkName === 'swebench-lite'
        ? {
            benchmarkVersion: sweBenchVersion,
            benchmarkLicense: sweBenchLicense,
            benchmarkSha256: await fileSha256(this.sweBenchPath()),
          }
        : {}),
      ...(benchmarkName === 'swe-polybench'
        ? {
            benchmarkVersion: swePolyBenchVersion,
            benchmarkLicense: swePolyBenchLicense,
            benchmarkSha256: await fileSha256(this.swePolyBenchPath()),
          }
        : {}),
      ...(benchmarkName === 'terminal-bench'
        ? {
            benchmarkVersion: terminalBenchVersion,
            benchmarkLicense: terminalBenchLicense,
            benchmarkSha256: await directorySha256(this.terminalBenchPath()),
          }
        : {}),
      ...(benchmarkName === 'native'
        ? { evidence: await createRunEvidence(cases, model.provider) }
        : {}),
      modelConfigDigest: model.configDigest,
    }
  }

  async model(id: CreateJobInput['modelId'], textOnly = false) {
    const security = createSecurityServices()
    if (id === 'mock') {
      return {
        security,
        provider: textOnly
          ? createModelProvider('mock', { mockSteps: [finalText('已完成任务，请运行测试验证。')] })
          : createEvalMockProvider(),
        config: undefined,
        configDigest: contentDigest({ model: 'mock', version: 1 }),
      }
    }
    if (!this.enableRealModels) {
      throw new PlatformError(400, 'MODEL_DISABLED', '服务端尚未启用真实模型。')
    }
    const config = await new ConfigLoader().load(this.root)
    const provider = new ProviderRegistry(
      new ModelProviderFactory(security.resolver),
    ).createFromConfig(config)
    return {
      security,
      provider,
      config,
      configDigest: contentDigest({
        agent: config.agent,
        provider: config.providers[config.agent.defaultProvider],
      }),
    }
  }

  private sweBenchPath() {
    return path.join(this.root, '.codex/datasets/swebench-lite-test.jsonl')
  }

  private swePolyBenchPath() {
    return (
      process.env.CODEDEN_SWE_POLYBENCH_DATASET ??
      path.join(this.root, '.codex/datasets/swe-polybench.jsonl')
    )
  }

  private terminalBenchPath() {
    return (
      process.env.CODEDEN_TERMINAL_BENCH_DATASET ??
      path.join(this.root, '.codex/datasets/terminal-bench')
    )
  }

  private async openSourceDataset(): Promise<CatalogDataset> {
    this.openSourceDatasetPromise ??= this.loadOpenSourceDataset()
    return this.openSourceDatasetPromise
  }

  private async loadOpenSourceDataset(): Promise<CatalogDataset> {
    try {
      const records = await loadSweBenchRecords(this.sweBenchPath())
      return {
        id: 'swebench-lite',
        family: '开源评测集',
        name: 'SWE-bench Lite',
        description: '真实 GitHub 修复题',
        count: records.length,
        version: sweBenchVersion,
        license: sweBenchLicense,
        cases: records.map((item) => ({
          id: item.instance_id,
          title: titleOf(item.problem_statement),
          repository: item.repo,
          version: item.version,
        })),
      }
    } catch {
      return {
        id: 'swebench-lite',
        family: '开源评测集',
        name: 'SWE-bench Lite',
        description: '未导入',
        count: 0,
        version: sweBenchVersion,
        license: sweBenchLicense,
        cases: [],
      }
    }
  }

  private async swePolyBenchDataset(): Promise<CatalogDataset> {
    this.swePolyBenchDatasetPromise ??= this.loadSwePolyBenchDataset()
    return this.swePolyBenchDatasetPromise
  }

  private async loadSwePolyBenchDataset(): Promise<CatalogDataset> {
    try {
      const records = await loadSwePolyBenchRecords(this.swePolyBenchPath())
      return {
        id: 'swe-polybench',
        family: '开源评测集',
        name: 'SWE-PolyBench',
        description: '多语言仓库级修复题',
        count: records.length,
        version: swePolyBenchVersion,
        license: swePolyBenchLicense,
        cases: records.map((item) => ({
          id: item.instance_id,
          title: titleOf(item.problem_statement),
          repository: item.repo,
          version: item.version,
        })),
      }
    } catch {
      return {
        id: 'swe-polybench',
        family: '开源评测集',
        name: 'SWE-PolyBench',
        description: '未导入',
        count: 0,
        version: swePolyBenchVersion,
        license: swePolyBenchLicense,
        cases: [],
      }
    }
  }

  private async terminalBenchDataset(): Promise<CatalogDataset> {
    this.terminalBenchDatasetPromise ??= this.loadTerminalBenchDataset()
    return this.terminalBenchDatasetPromise
  }

  private async loadTerminalBenchDataset(): Promise<CatalogDataset> {
    try {
      const tasks = await loadTerminalBenchTasks(this.terminalBenchPath())
      return {
        id: 'terminal-bench',
        family: '开源评测集',
        name: 'Terminal-Bench',
        description: '容器化终端任务',
        count: tasks.length,
        version: terminalBenchVersion,
        license: terminalBenchLicense,
        cases: tasks.map((item) => ({ id: item.id, title: item.title })),
      }
    } catch {
      return {
        id: 'terminal-bench',
        family: '开源评测集',
        name: 'Terminal-Bench',
        description: '未导入',
        count: 0,
        version: terminalBenchVersion,
        license: terminalBenchLicense,
        cases: [],
      }
    }
  }
}

function titleOf(statement: string) {
  const title =
    statement
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? '未命名题目'
  return title.length > 100 ? `${title.slice(0, 97)}…` : title
}

function assertSelectedIds(selected: string[] | undefined, available: string[]) {
  if (!selected) {
    return
  }
  const known = new Set(available)
  if (selected.some((id) => !known.has(id))) {
    throw new PlatformError(400, 'CASE_NOT_FOUND', '选择的题目不在评测集内。')
  }
}

function repeatCases(cases: EvalCase[], repetitions: number) {
  return Array.from({ length: repetitions }, (_, repetition) =>
    cases.map((item) => ({
      ...item,
      id: repetitions === 1 ? item.id : `${item.id}#${repetition + 1}`,
    })),
  ).flat()
}

async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = []
  for await (const item of items) {
    result.push(item)
  }
  return result
}

async function fileSha256(filePath: string) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function directorySha256(directory: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(current: string, relative: string) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '__pycache__') {
        continue
      }
      const next = path.join(current, entry.name)
      const nextRelative = path.join(relative, entry.name)
      if (entry.isDirectory()) {
        await visit(next, nextRelative)
      } else if (entry.isFile()) {
        hash.update(nextRelative)
        hash.update(await readFile(next))
      }
    }
  }
  await stat(directory)
  await visit(directory, '')
  return hash.digest('hex')
}

function toBenchmarkRunSnapshot(snapshot: JobSnapshot): BenchmarkRunSnapshot {
  return {
    datasetId: snapshot.datasetId,
    datasetName: snapshot.datasetName,
    benchmarkName: snapshot.benchmarkName,
    harnessType: snapshot.harnessType,
    ...(snapshot.benchmarkVersion ? { benchmarkVersion: snapshot.benchmarkVersion } : {}),
    ...(snapshot.benchmarkLicense ? { benchmarkLicense: snapshot.benchmarkLicense } : {}),
    ...(snapshot.benchmarkSha256 ? { benchmarkSha256: snapshot.benchmarkSha256 } : {}),
    cases: snapshot.cases,
    ...(snapshot.evidence ? { evidence: snapshot.evidence } : {}),
  }
}
