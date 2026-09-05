import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentSubmission } from '@codeden/core/agent-submission.js'
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
import { humanevalSafeId, loadHumanEvalRecords } from './humaneval.loader.js'
import type { HumanEvalRecord } from './humaneval.schema.js'

const VERIFIER_WORKSPACE_PATH = '.codeden-humaneval-verifier.py'

export interface HumanEvalAdapterOptions {
  datasetVersion: string
  license: string
  sha256: string
  /** 返回该题的 fixture 目录：内含 stub/humaneval/<safe>.py 与 .codeden-verifier/run_tests.py。 */
  fixtureFor: (record: HumanEvalRecord) => string
  timeoutMs?: number
  maxTurns?: number
  maxToolCalls?: number
}

/**
 * HumanEval：函数合成题。Agent 在 stub 文件里补全实现；
 * 判卷在隔离工作区写回隐藏测试后以 `python` 执行，退出码 0 为通过。
 */
export class HumanEvalAdapter implements BenchmarkPort {
  readonly name = 'humaneval'
  private readonly graders: CompositeGrader

  constructor(
    private readonly options: HumanEvalAdapterOptions,
    graders = new CompositeGrader(),
  ) {
    assertDeclaredDatasetLicense(options.license)
    if (!/^[a-f0-9]{64}$/iu.test(options.sha256)) {
      throw new Error('HumanEval dataset SHA256 must contain 64 hexadecimal characters')
    }
    this.graders = graders
  }

  async *load(source: BenchmarkSource): AsyncIterable<EvalCase> {
    if (source.kind !== 'file') {
      throw new Error('HumanEval adapter requires a JSON or JSONL file')
    }
    for (const record of await loadHumanEvalRecords(source.path)) {
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

  async verify(
    preparedCase: PreparedCase,
    submission: AgentSubmission | undefined,
    context: VerificationContext,
  ): Promise<VerificationResult> {
    const scriptPath = preparedCase.evalCase.metadata?.verifierScript
    if (!scriptPath) {
      throw new Error(`HumanEval case缺少判卷脚本：${preparedCase.evalCase.id}`)
    }
    const verifier = await readFile(scriptPath, 'utf8')
    // 隐藏测试只写入隔离判卷工作区；Agent 工作区自始至终不可见。
    await context.workspace.writeFile(VERIFIER_WORKSPACE_PATH, verifier)
    return this.graders.gradeAll(preparedCase.evalCase.verification.graders, {
      workspace: context.workspace,
      submission,
    })
  }

  private toEvalCase(record: HumanEvalRecord): EvalCase {
    const safeId = humanevalSafeId(record.task_id)
    const workspaceFile = `humaneval/${safeId}.py`
    const fixtureDir = this.options.fixtureFor(record)
    return parseEvalCase({
      schemaVersion: 1,
      id: record.task_id,
      suite: 'validation',
      tags: ['humaneval', 'python'],
      metadata: {
        source: this.name,
        version: this.options.datasetVersion,
        upstreamId: record.task_id,
        license: this.options.license,
        language: 'python',
        testCommand: `python ${VERIFIER_WORKSPACE_PATH}`,
        verifierScript: path.join(fixtureDir, '.codeden-verifier', 'run_tests.py'),
        sha256: this.options.sha256,
        verificationMode: 'isolated',
      },
      task: {
        prompt: [
          `请补全 Python 函数 \`${record.entry_point}\` 的实现。`,
          '',
          '函数签名、docstring 与已有导入必须原样保留，只填充函数体；不要创建或修改其他文件。',
          '完成后确保实现满足 docstring 中描述的行为。',
          '',
          '```python',
          record.prompt.trimEnd(),
          '```',
        ].join('\n'),
        taskSpec: {
          id: record.task_id,
          goal: `完成函数 ${record.entry_point} 的实现`,
          acceptanceCriteria: [`隐藏测试 check(${record.entry_point}) 全部通过`],
          constraints: [`只能修改 ${workspaceFile}`, '不得修改函数签名或删除导入'],
          allowedPaths: [workspaceFile],
          verificationCommands: [`python ${VERIFIER_WORKSPACE_PATH}`],
        },
      },
      fixture: {
        path: path.join(fixtureDir, 'stub'),
      },
      limits: {
        timeoutMs: this.options.timeoutMs ?? 120_000,
        maxTurns: this.options.maxTurns ?? 12,
        maxToolCalls: this.options.maxToolCalls ?? 24,
      },
      submission: { type: 'files', allowedPaths: [workspaceFile] },
      verification: {
        graders: [
          {
            type: 'command',
            command: 'python',
            args: [VERIFIER_WORKSPACE_PATH],
            timeoutMs: this.options.timeoutMs ?? 120_000,
          },
        ],
      },
    })
  }
}
