import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { parseEvalCase } from '@codeden/eval-engine/domain/eval-case.js'
import {
  loadHumanEvalRecords,
  humanevalSafeId,
} from '@codeden/eval-engine/adapters/benchmarks/humaneval/humaneval.loader.js'
import { HumanEvalAdapter } from '@codeden/eval-engine/adapters/benchmarks/humaneval/humaneval.adapter.js'
import { loadNativeCaseFile } from '@codeden/eval-engine/adapters/benchmarks/native/native-case-loader.js'
import { SweBenchAdapter } from '@codeden/eval-engine/adapters/benchmarks/swebench/swebench.adapter.js'
import { loadSweBenchRecords } from '@codeden/eval-engine/adapters/benchmarks/swebench/swebench.loader.js'
import { SwePolyBenchAdapter } from '@codeden/eval-engine/adapters/benchmarks/swepolybench/swepolybench.adapter.js'
import { loadSwePolyBenchRecords } from '@codeden/eval-engine/adapters/benchmarks/swepolybench/swepolybench.loader.js'
import { TerminalBenchAdapter } from '@codeden/eval-engine/adapters/benchmarks/terminalbench/terminalbench.adapter.js'
import { loadTerminalBenchTasks } from '@codeden/eval-engine/adapters/benchmarks/terminalbench/terminalbench.loader.js'
import { createRunEvidence } from '@codeden/eval-engine/optimization/run-evidence.js'
import type { EvalCase } from '@codeden/eval-engine/domain/eval-case.js'
import type { RunEvidence } from '@codeden/eval-engine/domain/eval-run.js'
import type { ModelProvider } from '@codeden/agent-runtime/models/model-provider.js'
import type { HarnessType } from './harness.js'

/**
 * M6 数据集注册表：每个第三方/内置评测集一个描述符，新增评测集只需注册一处。
 * catalog 消费注册表生成目录视图与冻结快照；executor 消费派生映射做 harness 回退。
 */

export const DATASET_ID_SCHEMA = z.enum([
  'regression',
  'persona',
  'all',
  'swebench-lite',
  'swebench-verified',
  'swe-polybench',
  'terminal-bench',
  'humaneval',
  'reviewed',
])
export type RegisteredDatasetId = z.infer<typeof DATASET_ID_SCHEMA>

/** 人工审核数据集来源（装配层接 TraceStore，避免 catalog/registry 反向依赖存储）。 */
export interface ReviewedDatasetSource {
  /** 返回最近发布的人工审核数据集版本；无已发布用例时返回 null。 */
  latest(): Promise<{
    name: string
    version: number
    digest: string
    cases: {
      id: string
      title: string
      taskInput: string
      criteria: {
        id: string
        kind: 'contains' | 'not_contains' | 'max_chars' | 'max_lines'
        value: string | number
        critical: boolean
        description: string
      }[]
    }[]
  } | null>
}

export interface DatasetSnapshotInput {
  selectedIds: string[] | undefined
  /** 执行根目录（fixture/数据集路径解析基准）。 */
  root: string
  model: ModelProvider
  reviewedSource?: ReviewedDatasetSource
}

export interface DatasetSnapshot {
  cases: EvalCase[]
  benchmarkName: string
  harnessType: HarnessType
  version?: string
  license?: string
  sha256?: string
  evidence?: RunEvidence
}

export interface DatasetRegistration {
  id: RegisteredDatasetId
  name: string
  family: string
  description: string
  license?: string
  version?: string
  benchmarkName: string
  harnessType: HarnessType
  /** 执行上限分组：扩展组（Docker 仓库级/多语言）享有更长时限。 */
  extended: boolean
  /** 目录视图（不含 id/family，由 catalog 统一拼装）。未导入时 count=0。 */
  view(): Promise<{
    name: string
    description: string
    count: number
    version?: string
    license?: string
    cases: { id: string; title: string; repository?: string; version?: string }[]
  }>
  /** 冻结快照：加载并筛选题目。 */
  snapshot(
    input: DatasetSnapshotInput,
  ): Promise<Omit<DatasetSnapshot, 'benchmarkName' | 'harnessType'> & { benchmarkName?: string }>
}

const firstOf = <T>(items: readonly T[], idOf: (item: T) => string) => items.slice(0, 1).map(idOf)

function sweBenchRegistration(options: {
  id: 'swebench-lite' | 'swebench-verified'
  name: string
  description: string
  version: string
  datasetPath: (root: string) => string
}): DatasetRegistration {
  const { id, name, description, version, datasetPath } = options
  return {
    id,
    name,
    family: '开源评测集',
    description,
    license: 'mit',
    version,
    benchmarkName: id,
    harnessType: 'swebench-official',
    extended: true,
    async view() {
      try {
        const records = await loadSweBenchRecords(
          datasetPath(process.env.CODEDEN_EVAL_ROOT ?? process.cwd()),
        )
        return {
          name,
          description,
          count: records.length,
          version,
          license: 'mit',
          cases: records.map((item) => ({
            id: item.instance_id,
            title: firstLine(item.problem_statement),
            repository: item.repo,
            version: item.version,
          })),
        }
      } catch {
        return { name, description: '未导入', count: 0, version, license: 'mit', cases: [] }
      }
    },
    async snapshot({ selectedIds, root }) {
      const sourcePath = datasetPath(root)
      const records = await loadSweBenchRecords(sourcePath)
      const ids = selectedIds ?? firstOf(records, (item) => item.instance_id)
      assertSelectedIds(
        ids,
        records.map((item) => item.instance_id),
      )
      const digest = await fileSha256(sourcePath)
      const benchmark = new SweBenchAdapter({
        datasetVersion: version,
        license: 'mit',
        sha256: digest,
        verificationMode: 'host-opt-in',
        resolveVerificationCommand: (_record, tests) => ({
          command: 'python',
          args: ['-m', 'pytest', '-q', ...tests],
        }),
      })
      const loaded = await collect(benchmark.load({ kind: 'file', path: sourcePath }))
      return {
        cases: loaded.filter((item) => ids.includes(item.id)),
        benchmarkName: id,
        version,
        license: 'mit',
        sha256: digest,
      }
    },
  }
}

/** 构建全部内置注册项；reviewed 依赖注入（catalog 持有 TraceStore 数据源）。 */
export function createDefaultRegistrations(
  context: { reviewedSource?: ReviewedDatasetSource } = {},
): DatasetRegistration[] {
  const resolveRoot = () => process.env.CODEDEN_EVAL_ROOT ?? process.cwd()
  return [
    sweBenchRegistration({
      id: 'swebench-lite',
      name: 'SWE-bench Lite',
      description: '真实 GitHub 修复题',
      version: 'SWE-bench_Lite-test',
      datasetPath: (root) => path.join(root, '.codex/datasets/swebench-lite-test.jsonl'),
    }),
    sweBenchRegistration({
      id: 'swebench-verified',
      name: 'SWE-bench Verified',
      description: '人工校验的 GitHub 修复题',
      version: 'SWE-bench_Verified-test',
      datasetPath: (root) => path.join(root, '.codex/datasets/swebench-verified.jsonl'),
    }),
    {
      id: 'swe-polybench',
      name: 'SWE-PolyBench',
      family: '开源评测集',
      description: '多语言仓库级修复题',
      license: 'cc-by-nc-4.0',
      version: process.env.CODEDEN_SWE_POLYBENCH_VERSION ?? '1.1',
      benchmarkName: 'swe-polybench',
      harnessType: 'swe-polybench-docker',
      extended: true,
      async view() {
        const description = '多语言仓库级修复题'
        const version = process.env.CODEDEN_SWE_POLYBENCH_VERSION ?? '1.1'
        try {
          const records = await loadSwePolyBenchRecords(
            process.env.CODEDEN_SWE_POLYBENCH_DATASET ??
              path.join(resolveRoot(), '.codex/datasets/swe-polybench.jsonl'),
          )
          return {
            name: 'SWE-PolyBench',
            description,
            count: records.length,
            version,
            license: 'cc-by-nc-4.0',
            cases: records.map((item) => ({
              id: item.instance_id,
              title: firstLine(item.problem_statement),
              repository: item.repo,
              version: item.version,
            })),
          }
        } catch {
          return {
            name: 'SWE-PolyBench',
            description: '未导入',
            count: 0,
            version,
            license: 'cc-by-nc-4.0',
            cases: [],
          }
        }
      },
      async snapshot({ selectedIds, root }) {
        const sourcePath =
          process.env.CODEDEN_SWE_POLYBENCH_DATASET ??
          path.join(root, '.codex/datasets/swe-polybench.jsonl')
        const version = process.env.CODEDEN_SWE_POLYBENCH_VERSION ?? '1.1'
        const records = await loadSwePolyBenchRecords(sourcePath)
        const ids = selectedIds ?? firstOf(records, (item) => item.instance_id)
        assertSelectedIds(
          ids,
          records.map((item) => item.instance_id),
        )
        const digest = await fileSha256(sourcePath)
        const benchmark = new SwePolyBenchAdapter({
          datasetVersion: version,
          license: 'cc-by-nc-4.0',
          sha256: digest,
          verificationMode: 'host-opt-in',
          imageFor: (record) =>
            `ghcr.io/timesler/swe-polybench.eval.x86_64.${record.instance_id}:v${version}`,
        })
        const loaded = await collect(benchmark.load({ kind: 'file', path: sourcePath }))
        return {
          cases: loaded.filter((item) => ids.includes(item.id)),
          benchmarkName: 'swe-polybench',
          version,
          license: 'cc-by-nc-4.0',
          sha256: digest,
        }
      },
    },
    {
      id: 'terminal-bench',
      name: 'Terminal-Bench',
      family: '开源评测集',
      description: '容器化终端任务',
      license: 'apache-2.0',
      version: process.env.CODEDEN_TERMINAL_BENCH_VERSION ?? '2.0',
      benchmarkName: 'terminal-bench',
      harnessType: 'terminal-bench-docker',
      extended: true,
      async view() {
        const description = '容器化终端任务'
        const version = process.env.CODEDEN_TERMINAL_BENCH_VERSION ?? '2.0'
        try {
          const tasks = await loadTerminalBenchTasks(terminalBenchRoot())
          return {
            name: 'Terminal-Bench',
            description,
            count: tasks.length,
            version,
            license: 'apache-2.0',
            cases: tasks.map((item) => ({ id: item.id, title: item.title })),
          }
        } catch {
          return {
            name: 'Terminal-Bench',
            description: '未导入',
            count: 0,
            version,
            license: 'apache-2.0',
            cases: [],
          }
        }
      },
      async snapshot({ selectedIds }) {
        const sourcePath = terminalBenchRoot()
        const version = process.env.CODEDEN_TERMINAL_BENCH_VERSION ?? '2.0'
        const tasks = await loadTerminalBenchTasks(sourcePath)
        const ids = selectedIds ?? firstOf(tasks, (item) => item.id)
        assertSelectedIds(
          ids,
          tasks.map((item) => item.id),
        )
        const digest = await directorySha256(sourcePath)
        const benchmark = new TerminalBenchAdapter({
          datasetVersion: version,
          license: 'apache-2.0',
          sha256: digest,
        })
        const loaded = await collect(benchmark.load({ kind: 'directory', path: sourcePath }))
        return {
          cases: loaded.filter((item) => ids.includes(item.id)),
          benchmarkName: 'terminal-bench',
          version,
          license: 'apache-2.0',
          sha256: digest,
        }
      },
    },
    {
      id: 'humaneval',
      name: 'HumanEval',
      family: '开源评测集',
      description: 'Python 函数合成题',
      license: 'mit',
      version: 'human-eval-164',
      benchmarkName: 'humaneval',
      harnessType: 'humaneval-docker',
      extended: true,
      async view() {
        try {
          const records = await loadHumanEvalRecords(humanevalPath())
          return {
            name: 'HumanEval',
            description: 'Python 函数合成题',
            count: records.length,
            version: 'human-eval-164',
            license: 'mit',
            cases: records.map((item) => ({
              id: item.task_id,
              title: `${item.entry_point} · ${item.task_id}`,
            })),
          }
        } catch {
          return {
            name: 'HumanEval',
            description: '未导入',
            count: 0,
            version: 'human-eval-164',
            license: 'mit',
            cases: [],
          }
        }
      },
      async snapshot({ selectedIds, root }) {
        const sourcePath = process.env.CODEDEN_HUMANEVAL_DATASET
          ? path.resolve(process.env.CODEDEN_HUMANEVAL_DATASET)
          : path.join(root, '.codex/datasets/humaneval.jsonl')
        const records = await loadHumanEvalRecords(sourcePath)
        const ids = selectedIds ?? firstOf(records, (item) => item.task_id)
        assertSelectedIds(
          ids,
          records.map((item) => item.task_id),
        )
        const selected = records.filter((item) => ids.includes(item.task_id))
        const fixturesRoot = path.join(path.dirname(sourcePath), 'humaneval-fixtures')
        await materializeHumanevalFixtures(selected, fixturesRoot)
        const digest = await fileSha256(sourcePath)
        const benchmark = new HumanEvalAdapter({
          datasetVersion: 'human-eval-164',
          license: 'mit',
          sha256: digest,
          fixtureFor: (record) => path.join(fixturesRoot, humanevalSafeId(record.task_id)),
        })
        const loaded = await collect(benchmark.load({ kind: 'file', path: sourcePath }))
        return {
          cases: loaded.filter((item) => ids.includes(item.id)),
          benchmarkName: 'humaneval',
          version: 'human-eval-164',
          license: 'mit',
          sha256: digest,
        }
      },
    },
    {
      id: 'reviewed',
      name: '人工审核集',
      family: '人工审核集',
      description: 'Trace 审核入库',
      license: 'restricted',
      benchmarkName: 'native',
      harnessType: 'native',
      extended: false,
      async view() {
        const version = context.reviewedSource ? await context.reviewedSource.latest() : null
        if (!version) {
          return { name: '人工审核集', description: '暂无已发布用例', count: 0, cases: [] }
        }
        return {
          name: version.name,
          description: `Trace 审核入库 · ${version.name} v${version.version}`,
          count: version.cases.length,
          version: `v${version.version}`,
          license: 'restricted',
          cases: version.cases.map((item) => ({ id: item.id, title: item.title })),
        }
      },
      async snapshot({ selectedIds, model }) {
        const version = context.reviewedSource ? await context.reviewedSource.latest() : null
        if (!version || version.cases.length === 0) {
          throw new Error('人工审核集暂无已发布用例。')
        }
        const ids = selectedIds ?? firstOf(version.cases, (item) => item.id)
        assertSelectedIds(
          ids,
          version.cases.map((item) => item.id),
        )
        const fixtureDir = path.join(
          resolveRoot(),
          '.codex/datasets/reviewed-fixtures/shared-empty',
        )
        await mkdir(fixtureDir, { recursive: true })
        const cases = version.cases
          .filter((item) => ids.includes(item.id))
          .map((item) => reviewedCaseToEvalCase(item, fixtureDir))
        return {
          cases,
          benchmarkName: 'native',
          version: `v${version.version}`,
          license: 'restricted',
          sha256: version.digest,
          evidence: await createRunEvidence(cases, model),
        }
      },
    },
    {
      id: 'regression',
      name: '文件修改回归',
      family: '内置评测集',
      description: '版本与文件结果',
      benchmarkName: 'native',
      harnessType: 'native',
      extended: false,
      async view() {
        return {
          name: '文件修改回归',
          description: '版本与文件结果',
          count: 1,
          cases: [{ id: 'update-package-version', title: '修改 package.json 版本' }],
        }
      },
      async snapshot({ root }) {
        return {
          cases: [
            await loadNativeCaseFile(
              path.join(root, 'evals/cases/regression/update-package-version.yaml'),
            ),
          ],
          benchmarkName: 'native',
        }
      },
    },
    {
      id: 'persona',
      name: '人格与 Token',
      family: '内置评测集',
      description: '表达与预算',
      benchmarkName: 'native',
      harnessType: 'native',
      extended: false,
      async view() {
        return {
          name: '人格与 Token',
          description: '表达与预算',
          count: 1,
          cases: [{ id: 'persona-concise', title: '简洁完成说明' }],
        }
      },
      async snapshot({ root, model }) {
        const cases = [
          await loadNativeCaseFile(path.join(root, 'evals/cases/regression/persona-concise.yaml')),
        ]
        return { cases, benchmarkName: 'native', evidence: await createRunEvidence(cases, model) }
      },
    },
    {
      id: 'all',
      name: '内置完整回归',
      family: '内置评测集',
      description: '全部内置用例',
      benchmarkName: 'native',
      harnessType: 'native',
      extended: false,
      async view() {
        return {
          name: '内置完整回归',
          description: '全部内置用例',
          count: 2,
          cases: [
            { id: 'update-package-version', title: '修改 package.json 版本' },
            { id: 'persona-concise', title: '简洁完成说明' },
          ],
        }
      },
      async snapshot({ root, model }) {
        const cases = await Promise.all(
          ['update-package-version', 'persona-concise'].map((name) =>
            loadNativeCaseFile(path.join(root, 'evals/cases/regression', `${name}.yaml`)),
          ),
        )
        return { cases, benchmarkName: 'native', evidence: await createRunEvidence(cases, model) }
      },
    },
  ]
}

/** 注册表索引：id → 描述符；catalog/executor 由此派生分支。 */
export function indexRegistrations(registrations: readonly DatasetRegistration[]) {
  return new Map(registrations.map((item) => [item.id, item]))
}

/** benchmarkName → datasetId（旧 Job 快照缺失 datasetId 时的回退）。 */
export function datasetIdForBenchmark(benchmarkName: string): RegisteredDatasetId | 'all' {
  const mapping: Record<string, RegisteredDatasetId> = {
    'swebench-lite': 'swebench-lite',
    'swebench-verified': 'swebench-verified',
    'swe-polybench': 'swe-polybench',
    'terminal-bench': 'terminal-bench',
    humaneval: 'humaneval',
  }
  return mapping[benchmarkName] ?? 'all'
}

/** benchmarkName → harnessType（旧 Job 快照缺失 harnessType 时的回退）。 */
export function harnessTypeForBenchmark(benchmarkName: string): HarnessType {
  const mapping: Record<string, HarnessType> = {
    'swebench-lite': 'swebench-official',
    'swebench-verified': 'swebench-official',
    'swe-polybench': 'swe-polybench-docker',
    'terminal-bench': 'terminal-bench-docker',
    humaneval: 'humaneval-docker',
  }
  return mapping[benchmarkName] ?? 'native'
}

/** 执行上限分组：扩展组享有 300s/30 轮/80 次调用。 */
export function isExtendedBenchmark(benchmarkName: string): boolean {
  return [
    'swebench-lite',
    'swebench-verified',
    'swe-polybench',
    'terminal-bench',
    'humaneval',
  ].includes(benchmarkName)
}

function terminalBenchRoot() {
  return (
    process.env.CODEDEN_TERMINAL_BENCH_DATASET ??
    path.join(process.env.CODEDEN_EVAL_ROOT ?? process.cwd(), '.codex/datasets/terminal-bench')
  )
}

function humanevalPath() {
  return (
    process.env.CODEDEN_HUMANEVAL_DATASET ??
    path.join(process.env.CODEDEN_EVAL_ROOT ?? process.cwd(), '.codex/datasets/humaneval.jsonl')
  )
}

function firstLine(value: string) {
  const line =
    value
      .split(/\r?\n/u)
      .find((item) => item.trim())
      ?.trim() ?? '未命名题目'
  return line.length > 100 ? `${line.slice(0, 97)}…` : line
}

function assertSelectedIds(selected: string[], available: string[]) {
  const known = new Set(available)
  if (selected.some((id) => !known.has(id))) {
    throw new Error('选择的题目不在评测集内。')
  }
}

async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = []
  for await (const item of items) {
    result.push(item)
  }
  return result
}

async function fileSha256(filePath: string) {
  const { createHash } = await import('node:crypto')
  const { readFile } = await import('node:fs/promises')
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function directorySha256(directory: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const { readdir, readFile, stat } = await import('node:fs/promises')
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

async function materializeHumanevalFixtures(
  records: { task_id: string; prompt: string }[],
  fixturesRoot: string,
) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  for (const record of records) {
    const safeId = humanevalSafeId(record.task_id)
    const stubPath = path.join(fixturesRoot, safeId, 'stub', 'humaneval', `${safeId}.py`)
    await mkdir(path.dirname(stubPath), { recursive: true })
    await writeFile(stubPath, record.prompt, 'utf8')
  }
}

function reviewedCaseToEvalCase(
  item: {
    id: string
    title: string
    taskInput: string
    criteria: {
      id: string
      kind: 'contains' | 'not_contains' | 'max_chars' | 'max_lines'
      value: string | number
      critical: boolean
      description: string
    }[]
  },
  fixtureDir: string,
): EvalCase {
  return parseEvalCaseSafe({
    schemaVersion: 1,
    id: item.id,
    suite: 'validation',
    tags: ['reviewed', 'text'],
    task: {
      prompt: item.taskInput,
      taskSpec: {
        id: item.id,
        goal: item.title,
        acceptanceCriteria: item.criteria.map((criterion) => criterion.description),
        constraints: ['以文本形式作答，不需要修改文件'],
        allowedPaths: [],
        verificationCommands: [],
      },
    },
    fixture: { path: fixtureDir },
    limits: { timeoutMs: 60_000, maxTurns: 8, maxToolCalls: 16 },
    submission: { type: 'text', allowedPaths: [] },
    verification: {
      graders: [
        {
          type: 'persona-rubric',
          threshold: 1,
          criteria: item.criteria.map((criterion) => ({
            id: criterion.id,
            kind: criterion.kind,
            value: criterion.value,
            critical: criterion.critical,
          })),
        },
      ],
    },
  })
}

function parseEvalCaseSafe(input: unknown): EvalCase {
  return parseEvalCase(input)
}
