import type { AgentSubmission } from '../../../domain/agent-submission.js'
import { parseEvalCase, type EvalCase } from '../../../domain/eval-case.js'
import type { VerificationResult } from '../../../domain/verification-result.js'
import { CompositeGrader } from '../../../graders/composite.grader.js'
import type {
  BenchmarkPort,
  BenchmarkSource,
  PreparedCase,
  VerificationContext,
} from '../../../ports/benchmark.port.js'
import type { WorkspacePort } from '../../../ports/workspace.port.js'
import { assertDeclaredDatasetLicense } from '../../../datasets/dataset-license-policy.js'
import { loadSweBenchRecords } from './swebench.loader.js'
import type { SweBenchRecord } from './swebench.schema.js'

export interface SweBenchAdapterOptions {
  datasetVersion: string
  license: string
  sha256: string
  verificationMode: 'host-opt-in' | 'isolated'
  resolveVerificationCommand(
    record: SweBenchRecord,
    tests: string[],
  ): { command: string; args: string[] }
  timeoutMs?: number
  maxTurns?: number
  maxToolCalls?: number
}

export class SweBenchAdapter implements BenchmarkPort {
  readonly name = 'swebench-lite'
  private readonly graders: CompositeGrader

  constructor(
    private readonly options: SweBenchAdapterOptions,
    graders = new CompositeGrader(),
  ) {
    assertDeclaredDatasetLicense(options.license)
    if (!/^[a-f0-9]{64}$/iu.test(options.sha256)) {
      throw new Error('SWE-bench dataset SHA256 must contain 64 hexadecimal characters')
    }
    this.graders = graders
  }

  async *load(source: BenchmarkSource): AsyncIterable<EvalCase> {
    if (source.kind !== 'file') {
      throw new Error('SWE-bench adapter requires a JSON or JSONL file')
    }
    for (const record of await loadSweBenchRecords(source.path)) {
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

  private toEvalCase(record: SweBenchRecord): EvalCase {
    const tests = [...new Set([...record.FAIL_TO_PASS, ...record.PASS_TO_PASS])]
    if (tests.length === 0) {
      throw new Error(`SWE-bench case has no verification tests: ${record.instance_id}`)
    }
    const verificationCommand = this.options.resolveVerificationCommand(record, tests)
    const protectedPaths = pathsAddedOrModifiedByPatch(record.test_patch)
    return parseEvalCase({
      schemaVersion: 1,
      id: record.instance_id,
      suite: 'validation',
      tags: ['swebench', 'python', record.repo],
      metadata: {
        source: this.name,
        version: this.options.datasetVersion,
        upstreamId: record.instance_id,
        license: this.options.license,
        repository: record.repo,
        baseCommit: record.base_commit,
        sha256: this.options.sha256,
        verificationMode: this.options.verificationMode,
      },
      task: {
        prompt: record.problem_statement,
        taskSpec: {
          id: record.instance_id,
          goal: record.problem_statement,
          acceptanceCriteria: tests.map((test) => `测试通过：${test}`),
          constraints: [
            `基于提交 ${record.base_commit} 完成修改`,
            '不得修改或删除既有测试来规避验证',
          ],
          allowedPaths: ['.'],
          verificationCommands: [
            [verificationCommand.command, ...verificationCommand.args].join(' '),
          ],
        },
      },
      fixture: {
        path: record.repo,
        repository: {
          repository: record.repo,
          baseCommit: record.base_commit,
          testPatch: record.test_patch,
          environmentSetupCommit: record.environment_setup_commit,
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
          ...(protectedPaths.length > 0
            ? [{ type: 'unchanged-paths', paths: protectedPaths }]
            : []),
          {
            type: 'command',
            command: verificationCommand.command,
            args: verificationCommand.args,
            timeoutMs: this.options.timeoutMs ?? 300_000,
          },
        ],
      },
    })
  }
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
