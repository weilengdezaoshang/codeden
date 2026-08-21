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
import { loadSweBenchRecords } from './swebench.loader.js'
import type { SweBenchRecord } from './swebench.schema.js'

export interface SweBenchAdapterOptions {
  datasetVersion: string
  license: string
  resolveFixturePath(record: SweBenchRecord): string
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
          verificationCommands: tests.length > 0 ? [`python -m pytest ${tests.join(' ')}`] : [],
        },
      },
      fixture: { path: this.options.resolveFixturePath(record) },
      limits: {
        timeoutMs: this.options.timeoutMs ?? 300_000,
        maxTurns: this.options.maxTurns ?? 30,
        maxToolCalls: this.options.maxToolCalls ?? 80,
      },
      submission: { type: 'files', allowedPaths: ['.'] },
      verification: {
        graders: [
          {
            type: 'command',
            command: 'python',
            args: ['-m', 'pytest', ...tests],
            timeoutMs: this.options.timeoutMs ?? 300_000,
          },
        ],
      },
    })
  }
}
