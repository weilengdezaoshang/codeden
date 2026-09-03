import type { AgentSubmission } from '@codeden/core/agent-submission.js'
import { splitVerificationCommand } from '@codeden/agent-runtime/verification/command-split.js'
import { parseEvalCase, type EvalCase } from '../../../domain/eval-case.js'
import type { VerificationResult } from '../../../domain/verification-result.js'
import { CompositeGrader } from '../../../graders/composite.grader.js'
import type {
  BenchmarkPort,
  BenchmarkSource,
  PreparedCase,
  VerificationContext,
} from '../../../ports/benchmark.port.js'
import type { WorkspacePort } from '@codeden/core/workspace/workspace-contracts.js'
import { assertDeclaredDatasetLicense } from '../../../datasets/dataset-license-policy.js'
import { loadSwePolyBenchRecords } from './swepolybench.loader.js'
import {
  recordDockerfile,
  recordTests,
  SwePolyBenchRecordSchema,
  type SwePolyBenchRecord,
} from './swepolybench.schema.js'

export interface SwePolyBenchAdapterOptions {
  datasetVersion: string
  license: string
  sha256: string
  verificationMode: 'host-opt-in' | 'isolated'
  timeoutMs?: number
  maxTurns?: number
  maxToolCalls?: number
  imageFor?(record: SwePolyBenchRecord): string | undefined
}

/** 将 SWE-PolyBench 多语言实例统一为平台 EvalCase；不硬编码 Python 判卷。 */
export class SwePolyBenchAdapter implements BenchmarkPort {
  readonly name = 'swe-polybench'
  private readonly graders: CompositeGrader

  constructor(
    private readonly options: SwePolyBenchAdapterOptions,
    graders = new CompositeGrader(),
  ) {
    assertDeclaredDatasetLicense(options.license)
    if (!/^[a-f0-9]{64}$/iu.test(options.sha256)) {
      throw new Error('SWE-PolyBench dataset SHA256 must contain 64 hexadecimal characters')
    }
    this.graders = graders
  }

  async *load(source: BenchmarkSource): AsyncIterable<EvalCase> {
    if (source.kind !== 'file') {
      throw new Error('SWE-PolyBench adapter requires a JSON or JSONL file')
    }
    for (const record of await loadSwePolyBenchRecords(source.path)) {
      yield this.toEvalCase(record)
    }
  }

  async prepare(evalCase: EvalCase, workspace: WorkspacePort): Promise<PreparedCase> {
    return {
      evalCase,
      workspace,
      agentTask: { prompt: evalCase.task.prompt, taskSpec: evalCase.task.taskSpec },
    }
  }

  verify(
    preparedCase: PreparedCase,
    submission: AgentSubmission | undefined,
    context: VerificationContext,
  ): Promise<VerificationResult> {
    return this.graders.gradeAll(preparedCase.evalCase.verification.graders, {
      workspace: context.workspace,
      submission,
    })
  }

  private toEvalCase(record: SwePolyBenchRecord): EvalCase {
    const parsed = SwePolyBenchRecordSchema.parse(record)
    const tests = recordTests(parsed)
    if (tests.length === 0 && !parsed.test_command.trim()) {
      throw new Error(`SWE-PolyBench case has no test command: ${parsed.instance_id}`)
    }
    const command = resolveCommand(parsed, tests, this.options.timeoutMs ?? 300_000)
    const commandArgs = command.args ?? []
    const protectedPaths = pathsAddedOrModifiedByPatch(parsed.test_patch)
    return parseEvalCase({
      schemaVersion: 1,
      id: parsed.instance_id,
      suite: 'validation',
      tags: ['swe-polybench', parsed.language.toLowerCase(), parsed.repo],
      metadata: {
        source: this.name,
        version: this.options.datasetVersion,
        upstreamId: parsed.instance_id,
        license: this.options.license,
        repository: parsed.repo,
        baseCommit: parsed.base_commit,
        language: parsed.language,
        testCommand: parsed.test_command || commandArgs.join(' '),
        ...(this.options.imageFor ? { image: this.options.imageFor(parsed) } : {}),
        sha256: this.options.sha256,
        verificationMode: this.options.verificationMode,
      },
      task: {
        prompt: parsed.problem_statement,
        taskSpec: {
          id: parsed.instance_id,
          goal: parsed.problem_statement,
          acceptanceCriteria: [
            ...(tests.length ? tests.map((test) => `测试通过：${test}`) : []),
            '评测命令成功退出',
          ],
          constraints: [
            `基于提交 ${parsed.base_commit} 完成修改`,
            '不得修改或删除既有测试来规避验证',
          ],
          allowedPaths: ['.'],
          verificationCommands: [[command.command, ...commandArgs].join(' ')],
        },
      },
      fixture: {
        path: parsed.repo,
        repository: {
          repository: parsed.repo,
          baseCommit: parsed.base_commit,
          testPatch: parsed.test_patch,
          environmentSetupCommit: parsed.environment_setup_commit,
        },
      },
      limits: {
        timeoutMs: this.options.timeoutMs ?? 300_000,
        maxTurns: this.options.maxTurns ?? 30,
        maxToolCalls: this.options.maxToolCalls ?? 80,
      },
      submission: { type: 'files', allowedPaths: ['.'] },
      verification: {
        graders: [
          ...(protectedPaths.length ? [{ type: 'unchanged-paths', paths: protectedPaths }] : []),
          {
            type: 'command',
            command: command.command,
            args: commandArgs,
            timeoutMs: command.timeoutMs,
          },
        ],
      },
    })
  }
}

function resolveCommand(record: SwePolyBenchRecord, tests: string[], timeoutMs: number) {
  const raw = record.test_command.trim()
  if (raw) {
    if (/[|;&><$`()]/u.test(raw)) {
      return { command: 'sh', args: ['-lc', raw], timeoutMs }
    }
    return (
      splitVerificationCommand(raw, timeoutMs) ?? { command: 'sh', args: ['-lc', raw], timeoutMs }
    )
  }
  const language = record.language.toLowerCase()
  if (language === 'python') {
    return { command: 'python', args: ['-m', 'pytest', '-q', ...tests], timeoutMs }
  }
  if (language === 'java') {
    return { command: 'mvn', args: ['-q', 'test'], timeoutMs }
  }
  const command = 'npm'
  const args = ['test', '--', ...tests]
  return { command, args, timeoutMs }
}

function pathsAddedOrModifiedByPatch(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split(/\r?\n/u)) {
    if (!line.startsWith('+++ b/')) {
      continue
    }
    const filePath = line.slice('+++ b/'.length).split('\t', 1)[0]
    if (filePath) {
      paths.add(filePath)
    }
  }
  return [...paths].sort()
}

export { recordDockerfile }
