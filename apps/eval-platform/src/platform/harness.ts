import { execFile } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type {
  WorkspaceFactory,
  WorkspaceFixture,
  WorkspacePort,
} from '@codeden/core/workspace/workspace-contracts.js'
import { NativeBenchmarkAdapter } from '@codeden/eval-engine/adapters/benchmarks/native/native-benchmark.adapter.js'
import { HumanEvalAdapter } from '@codeden/eval-engine/adapters/benchmarks/humaneval/humaneval.adapter.js'
import { humanevalSafeId } from '@codeden/eval-engine/adapters/benchmarks/humaneval/humaneval.loader.js'
import { SweBenchAdapter } from '@codeden/eval-engine/adapters/benchmarks/swebench/swebench.adapter.js'
import { SwePolyBenchAdapter } from '@codeden/eval-engine/adapters/benchmarks/swepolybench/swepolybench.adapter.js'
import { TerminalBenchAdapter } from '@codeden/eval-engine/adapters/benchmarks/terminalbench/terminalbench.adapter.js'
import { RepositoryWorkspaceFactory } from '@codeden/eval-engine/adapters/workspaces/repository-workspace.factory.js'
import { TemporaryWorkspaceAdapter } from '@codeden/agent-runtime/workspace/temporary-workspace.js'
import { createSandboxRunner } from '@codeden/agent-runtime/sandbox/sandbox-runner-factory.js'
import type { BenchmarkPort } from '@codeden/eval-engine/ports/benchmark.port.js'
import type { VerificationResult } from '@codeden/eval-engine/domain/verification-result.js'
import type { RunCommandOptions } from '@codeden/agent-runtime/tools/builtins/run-command.js'
import type { StoredJob } from './schema.js'

const execFileAsync = promisify(execFile)
export const SWE_BENCH_DOCKER_PLATFORM =
  process.env.CODEDEN_SWEBENCH_DOCKER_PLATFORM ?? 'linux/amd64'
export type HarnessType =
  | 'native'
  | 'codeden-docker'
  | 'swebench-official'
  | 'swe-polybench-docker'
  | 'terminal-bench-docker'
  | 'humaneval-docker'

export interface HarnessPrepareContext {
  job: StoredJob
  evalRoot: string
  sandboxMode: RunCommandOptions['mode']
  signal: AbortSignal
}

export interface PreparedHarness {
  benchmark: BenchmarkPort
  workspaceFactory: WorkspaceFactory
  commandOptionsForTask(taskId: string): RunCommandOptions
  dispose(): Promise<void>
}

export interface EvaluationHarness {
  readonly type: HarnessType
  prepare(context: HarnessPrepareContext): Promise<PreparedHarness>
}

export class HarnessRegistry {
  private readonly harnesses = new Map<HarnessType, EvaluationHarness>()
  register(harness: EvaluationHarness) {
    if (this.harnesses.has(harness.type)) {
      throw new Error(`Harness 已注册：${harness.type}`)
    }
    this.harnesses.set(harness.type, harness)
    return this
  }
  get(type: HarnessType) {
    const harness = this.harnesses.get(type)
    if (!harness) {
      throw new Error(`Harness 未注册：${type}`)
    }
    return harness
  }
}

export class NativeHarness implements EvaluationHarness {
  readonly type = 'native' as const
  async prepare(context: HarnessPrepareContext): Promise<PreparedHarness> {
    const commandOptions = sandboxOptions(context.sandboxMode, 'node:24-bookworm-slim')
    return {
      benchmark: new NativeBenchmarkAdapter(),
      workspaceFactory: new RepositoryWorkspaceFactory({ commandOptions }),
      commandOptionsForTask: () => commandOptions,
      async dispose() {},
    }
  }
}

export class CodeDenDockerHarness implements EvaluationHarness {
  readonly type = 'codeden-docker' as const
  async prepare(context: HarnessPrepareContext): Promise<PreparedHarness> {
    const { job, evalRoot, sandboxMode, signal } = context
    const configuredImage = process.env.CODEDEN_EVAL_SANDBOX_IMAGE
    if (sandboxMode === 'docker' && !configuredImage) {
      await prepareMissingEnvironments(job, evalRoot, signal)
    }

    const imageByTask = new Map<string, string>()
    const imageByFixture = new Map<string, string>()
    for (const evalCase of job.snapshot.cases) {
      const image =
        configuredImage ??
        (sandboxMode === 'docker'
          ? (await readEnvironmentManifest(evalRoot, caseEnvironmentId(evalCase)))?.image
          : undefined)
      if (sandboxMode === 'docker' && !image) {
        throw new Error(`CodeDen Docker Harness 未能准备环境：${caseEnvironmentId(evalCase)}`)
      }
      if (image) {
        imageByTask.set(evalCase.task.taskSpec.id, image)
        if (evalCase.fixture.repository) {
          imageByFixture.set(fixtureKey(evalCase.fixture), image)
        }
      }
    }

    const optionsForImage = (image?: string) => sandboxOptions(sandboxMode, image)
    const agentWorkspaceFactory: WorkspaceFactory = {
      create: (fixture) =>
        new RepositoryWorkspaceFactory({
          commandOptions: optionsForImage(imageByFixture.get(fixtureKey(fixture))),
          allowVerificationCommands: true,
          applyTestPatch: false,
          initializeCommand: { command: 'python', args: ['-c', 'pass'], timeoutMs: 300_000 },
        }).create(fixture),
    }
    const verificationWorkspaceFactory: WorkspaceFactory = {
      create: (fixture) =>
        new RepositoryWorkspaceFactory({
          commandOptions: optionsForImage(imageByFixture.get(fixtureKey(fixture))),
          allowVerificationCommands: true,
          applyTestPatch: true,
          initializeCommand: { command: 'python', args: ['-c', 'pass'], timeoutMs: 300_000 },
        }).create(fixture),
    }

    const delegate = new SweBenchAdapter({
      datasetVersion: job.snapshot.benchmarkVersion!,
      license: job.snapshot.benchmarkLicense!,
      sha256: job.snapshot.benchmarkSha256!,
      verificationMode: 'isolated',
      resolveVerificationCommand: (_record, tests) => ({
        command: 'python',
        args: ['-m', 'pytest', '-q', ...tests],
      }),
    })
    return {
      benchmark: isolatedVerificationBenchmark(delegate, verificationWorkspaceFactory),
      workspaceFactory: agentWorkspaceFactory,
      commandOptionsForTask: (taskId) =>
        optionsForImage(configuredImage ?? imageByTask.get(taskId)),
      async dispose() {},
    }
  }
}

export class SweBenchOfficialHarness implements EvaluationHarness {
  readonly type = 'swebench-official' as const

  async prepare(context: HarnessPrepareContext): Promise<PreparedHarness> {
    const { job, evalRoot, signal } = context
    const python =
      process.env.CODEDEN_SWEBENCH_PYTHON ?? path.join(evalRoot, '.codex/venvs/swebench/bin/python')
    await access(python).catch(() => {
      throw new Error(`找不到 SWE-bench 官方 Harness Python：${python}`)
    })
    const dataset =
      process.env.CODEDEN_SWEBENCH_OFFICIAL_DATASET ??
      sweBenchOfficialDatasetFor(job.snapshot.benchmarkName)
    const imageByInstance = await resolveOfficialImages(
      python,
      dataset,
      job.snapshot.cases.map(caseEnvironmentId),
      evalRoot,
      signal,
    )
    const imageByFixture = new Map<string, string>()
    for (const evalCase of job.snapshot.cases) {
      if (evalCase.fixture.repository) {
        imageByFixture.set(
          fixtureKey(evalCase.fixture),
          requiredOfficialImage(imageByInstance, caseEnvironmentId(evalCase)),
        )
      }
    }
    const optionsForImage = (image: string): RunCommandOptions => ({
      ...sandboxOptions(context.sandboxMode, image, SWE_BENCH_DOCKER_PLATFORM),
      user: 'root',
    })
    const delegate = new SweBenchAdapter({
      datasetVersion: job.snapshot.benchmarkVersion!,
      license: job.snapshot.benchmarkLicense!,
      sha256: job.snapshot.benchmarkSha256!,
      verificationMode: 'isolated',
      resolveVerificationCommand: () => ({ command: 'python', args: ['-m', 'pytest'] }),
    })
    return {
      benchmark: officialVerificationBenchmark(delegate, {
        python,
        dataset,
        evalRoot,
        signal,
        dockerPlatform: SWE_BENCH_DOCKER_PLATFORM,
      }),
      workspaceFactory: {
        create: (fixture) =>
          new RepositoryWorkspaceFactory({
            commandOptions: optionsForImage(
              requiredOfficialImage(imageByFixture, fixtureKey(fixture)),
            ),
            allowVerificationCommands: false,
            applyTestPatch: false,
          }).create(fixture),
      },
      commandOptionsForTask: (taskId) =>
        optionsForImage(requiredOfficialImage(imageByInstance, taskId)),
      async dispose() {},
    }
  }
}

/** SWE-PolyBench 的实例镜像和测试命令均由数据集实例决定。 */
export class SwePolyBenchDockerHarness implements EvaluationHarness {
  readonly type = 'swe-polybench-docker' as const

  async prepare(context: HarnessPrepareContext): Promise<PreparedHarness> {
    const { job, sandboxMode } = context
    const configuredImage = process.env.CODEDEN_SWE_POLYBENCH_IMAGE
    const imageByTask = new Map<string, string>()
    const imageByFixture = new Map<string, string>()
    for (const evalCase of job.snapshot.cases) {
      const image = configuredImage ?? evalCase.metadata?.image
      if (sandboxMode === 'docker' && !image) {
        throw new Error(`SWE-PolyBench 实例缺少 Docker 镜像：${evalCase.id}`)
      }
      if (image) {
        imageByTask.set(evalCase.task.taskSpec.id, image)
        if (evalCase.fixture.repository) {
          imageByFixture.set(fixtureKey(evalCase.fixture), image)
        }
      }
    }
    const optionsForImage = (image?: string) => sandboxOptions(sandboxMode, image)
    const agentWorkspaceFactory: WorkspaceFactory = {
      create: (fixture) =>
        new RepositoryWorkspaceFactory({
          commandOptions: optionsForImage(imageByFixture.get(fixtureKey(fixture))),
          allowVerificationCommands: false,
          applyTestPatch: false,
        }).create(fixture),
    }
    const verificationWorkspaceFactory: WorkspaceFactory = {
      create: (fixture) =>
        new RepositoryWorkspaceFactory({
          commandOptions: optionsForImage(imageByFixture.get(fixtureKey(fixture))),
          allowVerificationCommands: true,
          applyTestPatch: true,
        }).create(fixture),
    }
    const delegate = new SwePolyBenchAdapter({
      datasetVersion: job.snapshot.benchmarkVersion ?? '1.1',
      license: job.snapshot.benchmarkLicense ?? 'cc-by-nc-4.0',
      sha256: job.snapshot.benchmarkSha256 ?? '0'.repeat(64),
      verificationMode: 'isolated',
    })
    return {
      benchmark: isolatedVerificationBenchmark(delegate, verificationWorkspaceFactory),
      workspaceFactory: agentWorkspaceFactory,
      commandOptionsForTask: (taskId) =>
        optionsForImage(configuredImage ?? imageByTask.get(taskId)),
      async dispose() {},
    }
  }
}

/** Terminal-Bench 任务按 environment 构建 Agent 镜像，验证阶段单独挂入 tests。 */
export class TerminalBenchDockerHarness implements EvaluationHarness {
  readonly type = 'terminal-bench-docker' as const

  async prepare(context: HarnessPrepareContext): Promise<PreparedHarness> {
    const { job, sandboxMode, signal } = context
    const configuredImage = process.env.CODEDEN_TERMINAL_BENCH_IMAGE
    const imageByTask = new Map<string, string>()
    const imageByFixture = new Map<string, string>()
    const taskByFixture = new Map<string, string>()
    for (const evalCase of job.snapshot.cases) {
      const taskPath = evalCase.fixture.path
      const image =
        configuredImage ??
        evalCase.metadata?.image ??
        `codeden-terminal-bench-${safeImagePart(evalCase.id)}:${job.snapshot.benchmarkVersion ?? '2.0'}`
      if (sandboxMode === 'docker' && !configuredImage && !evalCase.metadata?.image) {
        await ensureTerminalImage(image, path.join(taskPath, 'environment'), signal)
      }
      imageByTask.set(evalCase.task.taskSpec.id, image)
      imageByFixture.set(taskPath, image)
      taskByFixture.set(taskPath, taskPath)
    }
    const optionsForImage = (image: string): RunCommandOptions => ({
      ...sandboxOptions(sandboxMode, image),
      network: process.env.CODEDEN_TERMINAL_BENCH_NETWORK ?? 'none',
      user: 'root',
    })
    const workspaceFactory = (includeVerifierFiles: boolean): WorkspaceFactory => ({
      create: (fixture, options = {}) => {
        const taskPath = taskByFixture.get(fixture.path)
        if (!taskPath) {
          throw new Error(`Terminal-Bench task 未注册：${fixture.path}`)
        }
        const image = imageByFixture.get(fixture.path)
        if (!image) {
          throw new Error(`Terminal-Bench 镜像未注册：${fixture.path}`)
        }
        return createTerminalWorkspace(
          taskPath,
          optionsForImage(image),
          includeVerifierFiles,
          options.signal,
        )
      },
    })
    return {
      benchmark: terminalVerificationBenchmark(
        new TerminalBenchAdapter({
          datasetVersion: job.snapshot.benchmarkVersion ?? '2.0',
          license: job.snapshot.benchmarkLicense ?? 'apache-2.0',
          sha256: job.snapshot.benchmarkSha256 ?? '0'.repeat(64),
        }),
        workspaceFactory(true),
      ),
      workspaceFactory: workspaceFactory(false),
      commandOptionsForTask: (taskId) => {
        const image = imageByTask.get(taskId)
        if (!image) {
          throw new Error(`Terminal-Bench 镜像未注册：${taskId}`)
        }
        return optionsForImage(image)
      },
      async dispose() {},
    }
  }
}

/** HumanEval：python 沙箱镜像 + 隐藏测试隔离判卷。 */
export class HumanEvalDockerHarness implements EvaluationHarness {
  readonly type = 'humaneval-docker' as const

  async prepare(context: HarnessPrepareContext): Promise<PreparedHarness> {
    const { job, sandboxMode } = context
    const image = process.env.CODEDEN_HUMANEVAL_IMAGE ?? 'python:3.11-slim'
    const commandOptions = sandboxOptions(sandboxMode, image)
    const delegate = new HumanEvalAdapter({
      datasetVersion: job.snapshot.benchmarkVersion ?? 'human-eval-164',
      license: job.snapshot.benchmarkLicense ?? 'mit',
      sha256: job.snapshot.benchmarkSha256 ?? '0'.repeat(64),
      fixtureFor: (record) => humanevalFixtureDir(record),
    })
    return {
      benchmark: isolatedVerificationBenchmark(
        delegate,
        new RepositoryWorkspaceFactory({
          commandOptions,
          allowVerificationCommands: true,
        }),
      ),
      workspaceFactory: new RepositoryWorkspaceFactory({ commandOptions }),
      commandOptionsForTask: () => commandOptions,
      async dispose() {},
    }
  }
}

function humanevalFixtureDir(record: { task_id: string }) {
  const root = process.env.CODEDEN_EVAL_ROOT ?? process.cwd()
  return path.join(root, '.codex/datasets/humaneval-fixtures', humanevalSafeId(record.task_id))
}

function sweBenchOfficialDatasetFor(benchmarkName: StoredJob['snapshot']['benchmarkName']) {
  return benchmarkName === 'swebench-verified'
    ? 'princeton-nlp/SWE-bench_Verified'
    : 'SWE-bench/SWE-bench_Lite'
}

function sweBenchDatasetPath(
  evalRoot: string,
  benchmarkName: StoredJob['snapshot']['benchmarkName'],
) {
  const fileName =
    benchmarkName === 'swebench-verified' ? 'swebench-verified.jsonl' : 'swebench-lite-test.jsonl'
  return path.resolve(evalRoot, '.codex/datasets', fileName)
}

async function resolveOfficialImages(
  python: string,
  dataset: string,
  instanceIds: readonly string[],
  cwd: string,
  signal: AbortSignal,
) {
  const script = [
    'import json, sys',
    'from swebench.harness.utils import load_swebench_dataset',
    'rows = load_swebench_dataset(sys.argv[1], "test", sys.argv[2:])',
    'print(json.dumps({row["instance_id"]: row["image"] for row in rows}))',
  ].join('; ')
  const { stdout } = await execFileAsync(python, ['-c', script, dataset, ...instanceIds], {
    cwd,
    signal,
    maxBuffer: 20 * 1024 * 1024,
  })
  const images = new Map(Object.entries(JSON.parse(stdout.trim()) as Record<string, string>))
  for (const instanceId of instanceIds) {
    requiredOfficialImage(images, instanceId)
  }
  return images
}

function requiredOfficialImage(images: ReadonlyMap<string, string>, key: string) {
  const image = images.get(key)
  if (!image) {
    throw new Error(`SWE-bench 官方数据缺少镜像：${key}`)
  }
  return image
}

export function createHarnessRegistry() {
  return new HarnessRegistry()
    .register(new NativeHarness())
    .register(new CodeDenDockerHarness())
    .register(new SweBenchOfficialHarness())
    .register(new SwePolyBenchDockerHarness())
    .register(new TerminalBenchDockerHarness())
    .register(new HumanEvalDockerHarness())
}

function officialVerificationBenchmark(
  delegate: BenchmarkPort,
  options: {
    python: string
    dataset: string
    evalRoot: string
    signal: AbortSignal
    dockerPlatform: string
  },
): BenchmarkPort {
  return {
    name: delegate.name,
    load: (source) => delegate.load(source),
    prepare: (evalCase, workspace) => delegate.prepare(evalCase, workspace),
    async verify(prepared, submission, context) {
      if (submission?.type !== 'files') {
        return officialResult('error', 'SWE-bench 官方 Harness 需要文件提交')
      }
      await stage(context, 'patch_generation', 'started')
      let patch: string
      try {
        patch = await workspacePatch(prepared.workspace.root, submission.changedPaths)
        if (!patch.trim()) {
          await stage(context, 'patch_generation', 'failed', 'Git patch 为空，未检测到文件差异')
          return officialResult('failed', 'Agent 没有生成可评测的 Git patch')
        }
        await stage(
          context,
          'patch_generation',
          'completed',
          `${submission.changedPaths.length} 个文件产生差异`,
        )
      } catch (error) {
        await stage(context, 'patch_generation', 'failed', readProcessOutput(error))
        throw error
      }
      const directory = await mkdtemp(path.join(tmpdir(), 'codeden-swebench-official-'))
      const predictionPath = path.join(directory, 'predictions.jsonl')
      const instanceId = prepared.evalCase.metadata?.upstreamId ?? prepared.evalCase.id
      const modelName = 'codeden'
      const runId = `codeden-${context.trialId.replace(/[^A-Za-z0-9_.-]/gu, '-')}`
      await stage(context, 'prediction_write', 'started')
      try {
        await writeFile(
          predictionPath,
          `${JSON.stringify({ instance_id: instanceId, model_name_or_path: modelName, model_patch: patch })}\n`,
          'utf8',
        )
        await stage(context, 'prediction_write', 'completed')
      } catch (error) {
        await stage(context, 'prediction_write', 'failed', readProcessOutput(error))
        throw error
      }
      let currentStage: import('@codeden/eval-engine/ports/benchmark.port.js').VerificationStage['name'] =
        'harness_execution'
      try {
        currentStage = 'harness_execution'
        await stage(context, currentStage, 'started')
        const processResult = await execFileAsync(
          options.python,
          [
            path.resolve(options.evalRoot, 'scripts/run-swebench-official.py'),
            '--dataset_name',
            options.dataset,
            '--split',
            'test',
            '--instance_ids',
            instanceId,
            '--predictions_path',
            predictionPath,
            '--max_workers',
            '1',
            '--timeout',
            String(Math.max(1, Math.ceil(prepared.evalCase.limits.timeoutMs / 1000))),
            '--run_id',
            runId,
            '--report_dir',
            directory,
          ],
          {
            cwd: options.evalRoot,
            signal: options.signal,
            env: {
              ...process.env,
              CODEDEN_SWEBENCH_DOCKER_PLATFORM: options.dockerPlatform,
            },
            maxBuffer: 20 * 1024 * 1024,
          },
        )
        await stage(
          context,
          currentStage,
          'completed',
          summarizeProcessOutput(processResult.stdout, processResult.stderr),
        )
        currentStage = 'report_read'
        await stage(context, currentStage, 'started')
        const report = JSON.parse(
          await readFile(path.join(directory, `${modelName}.${runId}.json`), 'utf8'),
        ) as OfficialReport
        await stage(context, currentStage, 'completed', summarizeOfficialReport(report, instanceId))
        currentStage = 'result_classification'
        await stage(context, currentStage, 'started')
        if (report.resolved_ids?.includes(instanceId)) {
          await stage(context, currentStage, 'completed', 'resolved')
          return officialResult('passed', 'SWE-bench 官方 Harness 判定 resolved')
        }
        const reason = report.failure_reasons?.[instanceId]
        if (
          report.infra_failure_ids?.includes(instanceId) ||
          report.error_ids?.includes(instanceId)
        ) {
          const log = await readOfficialHarnessLog(options.evalRoot, runId, modelName, instanceId)
          const message = reason ?? reportErrorSummary(report, instanceId, log)
          await stage(context, currentStage, 'failed', message)
          return officialResult('error', message)
        }
        const message = reason ?? 'SWE-bench 官方 Harness 判定 unresolved'
        await stage(context, currentStage, 'completed', message)
        return officialResult('failed', message)
      } catch (error) {
        const message = readProcessOutput(error)
        await stage(context, currentStage, 'failed', message)
        throw new Error(`SWE-bench 官方 Harness 在「${currentStage}」阶段失败：${message}`)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

function reportErrorSummary(report: OfficialReport, instanceId: string, harnessLog?: string) {
  const errorIds = report.error_ids?.filter((id) => id === instanceId) ?? []
  const infrastructureIds = report.infra_failure_ids?.filter((id) => id === instanceId) ?? []
  const reportStatus = summarizeOfficialReport(report, instanceId)
  const logSummary = harnessLog ? `官方 Harness 日志：${summarizeHarnessLog(harnessLog)}` : ''
  return [
    'SWE-bench 结果报告将该实例标记为 error。',
    reportStatus,
    `error_ids=${errorIds.length ? errorIds.join(',') : '未提供'}`,
    `infra_failure_ids=${infrastructureIds.length ? infrastructureIds.join(',') : '未提供'}`,
    logSummary || '报告未提供 failure_reasons，且未找到官方 Harness 实例日志。',
  ]
    .filter(Boolean)
    .join(' ')
}

async function readOfficialHarnessLog(
  evalRoot: string,
  runId: string,
  modelName: string,
  instanceId: string,
) {
  const logPath = path.join(
    evalRoot,
    'logs/run_evaluation',
    runId,
    modelName,
    instanceId,
    'run_instance.log',
  )
  try {
    return await readFile(logPath, 'utf8')
  } catch {
    return undefined
  }
}

function summarizeHarnessLog(log: string) {
  const lines = log
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  const important = lines.filter((line) =>
    /Error in evaluation for|EvaluationError:|docker\.errors\.|requests\.exceptions\.|no matching manifest|no such image|TLS handshake timeout|permission denied|timed out|Check \(/iu.test(
      line,
    ),
  )
  const selected = (important.length ? important.slice(-8) : lines.slice(-8)).join(' | ')
  return selected.length > 4_000 ? `…${selected.slice(-4_000)}` : selected
}

function summarizeOfficialReport(report: OfficialReport, instanceId: string) {
  const status = report.resolved_ids?.includes(instanceId)
    ? 'resolved'
    : report.error_ids?.includes(instanceId)
      ? 'error'
      : report.infra_failure_ids?.includes(instanceId)
        ? 'infra_failure'
        : report.unresolved_ids?.includes(instanceId)
          ? 'unresolved'
          : 'missing'
  const reason = report.failure_reasons?.[instanceId]
  return [
    `实例=${instanceId}`,
    `status=${status}`,
    `resolved=${report.resolved_ids?.length ?? 0}`,
    `unresolved=${report.unresolved_ids?.length ?? 0}`,
    `error=${report.error_ids?.length ?? 0}`,
    `infra_failure=${report.infra_failure_ids?.length ?? 0}`,
    `failure_reason=${reason ?? '未提供'}`,
  ].join('；')
}

function summarizeProcessOutput(stdout: string, stderr: string) {
  const parts = [
    stdout.trim() ? `stdout：${stdout.trim()}` : '',
    stderr.trim() ? `stderr：${stderr.trim()}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join('\n') : '进程退出码：0；未输出 stdout/stderr。'
}

async function stage(
  context: {
    onStage?: (
      stage: import('@codeden/eval-engine/ports/benchmark.port.js').VerificationStage,
    ) => Promise<void>
  },
  name: import('@codeden/eval-engine/ports/benchmark.port.js').VerificationStage['name'],
  status: import('@codeden/eval-engine/ports/benchmark.port.js').VerificationStage['status'],
  message?: string,
) {
  await context.onStage?.({ name, status, ...(message ? { message: message.slice(-4_000) } : {}) })
}

interface OfficialReport {
  resolved_ids?: string[]
  unresolved_ids?: string[]
  infra_failure_ids?: string[]
  error_ids?: string[]
  failure_reasons?: Record<string, string>
}

function officialResult(status: VerificationResult['status'], message: string): VerificationResult {
  const passed = status === 'passed'
  return {
    status,
    scores: { 'swebench-official:1': passed ? 1 : 0 },
    graderResults: [
      {
        graderType: 'swebench-official',
        passed,
        score: passed ? 1 : 0,
        message,
        evidence: [message],
      },
    ],
    message,
  }
}

async function workspacePatch(root: string, changedPaths: readonly string[]) {
  for (const changedPath of changedPaths) {
    try {
      await access(path.join(root, changedPath))
      await execFileAsync('git', ['-C', root, 'add', '--intent-to-add', '--', changedPath])
    } catch {
      // Tracked deletions are already included by git diff; missing paths need no intent-to-add.
    }
  }
  const { stdout } = await execFileAsync('git', ['-C', root, 'diff', '--binary', '--no-ext-diff'], {
    maxBuffer: 20 * 1024 * 1024,
  })
  return stdout
}

function isolatedVerificationBenchmark(
  delegate: BenchmarkPort,
  verificationFactory: WorkspaceFactory,
): BenchmarkPort {
  return {
    name: delegate.name,
    load: (source) => delegate.load(source),
    prepare: (evalCase, workspace) => delegate.prepare(evalCase, workspace),
    async verify(prepared, submission, context) {
      const diffs = await prepared.workspace.fileDiffs?.()
      if (!diffs) {
        throw new Error('Harness 需要 Workspace 提供文件差异以执行独立判卷')
      }
      const verificationWorkspace = await verificationFactory.create(prepared.evalCase.fixture)
      try {
        for (const diff of diffs) {
          if (diff.binary) {
            throw new Error(`暂不支持二进制提交：${diff.path}`)
          }
          if (diff.deleted) {
            if (!verificationWorkspace.deleteFile) {
              throw new Error(`判卷工作区不支持删除文件：${diff.path}`)
            }
            await verificationWorkspace.deleteFile(diff.path)
          } else {
            await verificationWorkspace.writeFile(diff.path, diff.after)
          }
        }
        const cleanPrepared = await delegate.prepare(prepared.evalCase, verificationWorkspace)
        return await delegate.verify(cleanPrepared, submission, {
          ...context,
          workspace: verificationWorkspace,
        })
      } finally {
        await verificationWorkspace.dispose()
      }
    },
  }
}

const terminalVerificationBenchmark = isolatedVerificationBenchmark

async function createTerminalWorkspace(
  taskPath: string,
  options: RunCommandOptions,
  includeVerifierFiles: boolean,
  signal?: AbortSignal,
): Promise<WorkspacePort> {
  signal?.throwIfAborted()
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-terminal-bench-'))
  const verifierRoot = path.join(root, '.codeden-verifier-tests')
  const sandboxRunner = createSandboxRunner(options)
  if (!sandboxRunner) {
    throw new Error('Terminal-Bench 必须使用 host 或 docker sandbox')
  }
  try {
    if (includeVerifierFiles) {
      await mkdir(verifierRoot, { recursive: true })
      const tests = path.join(taskPath, 'tests')
      if (await pathExists(tests)) {
        await cp(tests, path.join(verifierRoot, 'tests'), { recursive: true })
      }
      const legacyScript = path.join(taskPath, 'run-tests.sh')
      if (await pathExists(legacyScript)) {
        await cp(legacyScript, path.join(verifierRoot, 'run-tests.sh'))
      }
    }
    return await TemporaryWorkspaceAdapter.fromExisting(root, {
      deleteOnDispose: true,
      allowCommands: true,
      allowVerificationCommands: includeVerifierFiles,
      sandboxRunner,
    })
  } catch (error) {
    await sandboxRunner.dispose().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

const terminalImagePromises = new Map<string, Promise<void>>()

async function ensureTerminalImage(image: string, environmentDir: string, signal: AbortSignal) {
  let pending = terminalImagePromises.get(image)
  if (!pending) {
    pending = (async () => {
      try {
        await execFileAsync('docker', ['image', 'inspect', image], { signal })
        return
      } catch {
        await execFileAsync('docker', ['build', '--tag', image, environmentDir], {
          signal,
          cwd: environmentDir,
          maxBuffer: 20 * 1024 * 1024,
        })
      }
    })()
    terminalImagePromises.set(image, pending)
  }
  try {
    await pending
  } catch (error) {
    terminalImagePromises.delete(image)
    throw new Error(`Terminal-Bench 环境镜像准备失败（${image}）：${readProcessOutput(error)}`)
  }
}

async function pathExists(target: string) {
  return access(target).then(
    () => true,
    () => false,
  )
}

function safeImagePart(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/gu, '-').slice(0, 100)
}

async function prepareMissingEnvironments(job: StoredJob, evalRoot: string, signal: AbortSignal) {
  for (const instanceId of [...new Set(job.snapshot.cases.map(caseEnvironmentId))]) {
    if (await environmentReady(evalRoot, instanceId, signal)) {
      continue
    }
    await withEnvironmentLock(evalRoot, instanceId, signal, async () => {
      if (await environmentReady(evalRoot, instanceId, signal)) {
        return
      }
      const datasetPath = sweBenchDatasetPath(evalRoot, job.snapshot.benchmarkName)
      const scriptPath = path.resolve(evalRoot, 'scripts/prepare-swebench-environment.mjs')
      try {
        await execFileAsync(
          process.execPath,
          [scriptPath, '--dataset', datasetPath, '--instance', instanceId],
          { cwd: evalRoot, signal, maxBuffer: 20 * 1024 * 1024 },
        )
      } catch (error) {
        throw new Error(`SWE-bench 环境准备失败（${instanceId}）：${readProcessOutput(error)}`)
      }
    })
  }
}

async function environmentReady(evalRoot: string, instanceId: string, signal: AbortSignal) {
  const manifest = await readEnvironmentManifest(evalRoot, instanceId)
  if (!manifest?.image) {
    return false
  }
  try {
    await execFileAsync('docker', ['image', 'inspect', manifest.image], { cwd: evalRoot, signal })
    return true
  } catch {
    return false
  }
}

async function withEnvironmentLock(
  evalRoot: string,
  instanceId: string,
  signal: AbortSignal,
  operation: () => Promise<void>,
) {
  const lockPath = path.resolve(environmentRoot(evalRoot, instanceId), '.build-lock')
  await mkdir(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 900; attempt++) {
    signal.throwIfAborted()
    try {
      await mkdir(lockPath)
      try {
        return await operation()
      } finally {
        await rm(lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      await delay(1_000, undefined, { signal })
    }
  }
  throw new Error(`等待环境构建锁超时：${instanceId}`)
}

async function readEnvironmentManifest(evalRoot: string, instanceId: string) {
  try {
    const value = JSON.parse(
      await readFile(path.join(environmentRoot(evalRoot, instanceId), 'environment.json'), 'utf8'),
    ) as { builderVersion?: unknown; image?: unknown }
    return value.builderVersion === 4 && typeof value.image === 'string' && value.image
      ? { image: value.image }
      : undefined
  } catch {
    return undefined
  }
}

function sandboxOptions(
  mode: RunCommandOptions['mode'],
  image?: string,
  platform?: string,
): RunCommandOptions {
  return {
    mode,
    ...(image ? { image } : {}),
    ...(platform ? { platform } : {}),
    cpus: 1,
    memoryLimit: '512m',
    pidsLimit: 128,
  }
}

function caseEnvironmentId(evalCase: StoredJob['snapshot']['cases'][number]) {
  return evalCase.metadata?.upstreamId ?? evalCase.id.split('#', 1)[0]!
}

function environmentRoot(evalRoot: string, instanceId: string) {
  return path.resolve(
    evalRoot,
    '.codex/swebench-environments',
    instanceId.replace(/[^A-Za-z0-9_.-]/gu, '_'),
  )
}

function fixtureKey(fixture: WorkspaceFixture) {
  const repository = fixture.repository
  return repository ? `${repository.repository}@${repository.baseCommit}` : fixture.path
}

function readProcessOutput(error: unknown) {
  if (!error || typeof error !== 'object') {
    return String(error)
  }
  const value = error as { message?: unknown; stdout?: unknown; stderr?: unknown }
  const output = [value.message, value.stdout, value.stderr]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join('\n')
  return output.length > 20_000 ? `…${output.slice(-20_000)}` : output
}
