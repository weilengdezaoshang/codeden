import type { AgentSubmission } from '@codeden/core/agent-submission.js'
import { parseEvalCase, type EvalCase } from '../../../domain/eval-case.js'
import type { VerificationResult } from '../../../domain/verification-result.js'
import type {
  BenchmarkPort,
  BenchmarkSource,
  PreparedCase,
  VerificationContext,
} from '../../../ports/benchmark.port.js'
import type { WorkspacePort } from '@codeden/core/workspace/workspace-contracts.js'
import { assertDeclaredDatasetLicense } from '../../../datasets/dataset-license-policy.js'
import { loadTerminalBenchTasks, type TerminalBenchTask } from './terminalbench.loader.js'

export interface TerminalBenchAdapterOptions {
  datasetVersion: string
  license: string
  sha256: string
  timeoutMs?: number
  maxTurns?: number
  maxToolCalls?: number
}

/** Terminal-Bench 2 任务目录适配器；tests/solution 不会被复制到 Agent 工作区。 */
export class TerminalBenchAdapter implements BenchmarkPort {
  readonly name = 'terminal-bench'

  constructor(private readonly options: TerminalBenchAdapterOptions) {
    assertDeclaredDatasetLicense(options.license)
    if (!/^[a-f0-9]{64}$/iu.test(options.sha256)) {
      throw new Error('Terminal-Bench dataset SHA256 must contain 64 hexadecimal characters')
    }
  }

  async *load(source: BenchmarkSource): AsyncIterable<EvalCase> {
    if (source.kind !== 'directory') {
      throw new Error('Terminal-Bench adapter requires a task directory')
    }
    for (const task of await loadTerminalBenchTasks(source.path)) {
      yield this.toEvalCase(task)
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
    _submission: AgentSubmission | undefined,
    context: VerificationContext,
  ): Promise<VerificationResult> {
    const script = preparedCase.evalCase.metadata?.verifierScript
    if (!script) {
      return terminalResult('error', 'Terminal-Bench 缺少 verifier script')
    }
    if (!isSafeRelativePath(script)) {
      return terminalResult('error', 'Terminal-Bench verifier script 路径非法')
    }
    const verifierPath = `.codeden-verifier-tests/${script}`
    await context.onStage?.({ name: 'harness_execution', status: 'started' })
    try {
      const output = await context.workspace.exec({
        command: 'bash',
        args: [verifierPath],
        timeoutMs: this.options.timeoutMs ?? 300_000,
      })
      const message = summarizeOutput(output.stdout, output.stderr)
      const result = terminalResult(output.exitCode === 0 ? 'passed' : 'failed', message)
      await context.onStage?.({
        name: 'harness_execution',
        status: output.exitCode === 0 ? 'completed' : 'failed',
        message,
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await context.onStage?.({ name: 'harness_execution', status: 'failed', message })
      return terminalResult('error', message)
    }
  }

  private toEvalCase(task: TerminalBenchTask): EvalCase {
    return parseEvalCase({
      schemaVersion: 1,
      id: task.id,
      suite: 'validation',
      tags: ['terminal-bench'],
      metadata: {
        source: this.name,
        version: this.options.datasetVersion,
        upstreamId: task.id,
        sha256: this.options.sha256,
        ...(task.environmentImage ? { image: task.environmentImage } : {}),
        verifierScript: task.verifierScript,
        verificationMode: 'isolated',
      },
      task: {
        prompt: task.instruction,
        taskSpec: {
          id: task.id,
          goal: task.instruction,
          acceptanceCriteria: ['Terminal-Bench verifier 成功退出'],
          constraints: ['不得读取或修改 solution/ 与 tests/ 中的评测材料'],
          allowedPaths: ['.'],
          verificationCommands: [`bash .codeden-verifier-tests/${task.verifierScript}`],
        },
      },
      fixture: { path: task.path },
      limits: {
        timeoutMs: this.options.timeoutMs ?? 300_000,
        maxTurns: this.options.maxTurns ?? 30,
        maxToolCalls: this.options.maxToolCalls ?? 80,
      },
      submission: { type: 'files', allowedPaths: ['.'] },
      verification: {
        graders: [{ type: 'terminal-bench', verifierScript: task.verifierScript }],
      },
    })
  }
}

function isSafeRelativePath(value: string) {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  )
}

function terminalResult(status: VerificationResult['status'], message: string): VerificationResult {
  const passed = status === 'passed'
  return {
    status,
    scores: { 'terminal-bench:1': passed ? 1 : 0 },
    graderResults: [
      {
        graderType: 'terminal-bench',
        passed,
        score: passed ? 1 : 0,
        message,
        evidence: [message],
      },
    ],
    message,
  }
}

function summarizeOutput(stdout: string, stderr: string) {
  const value = [
    stdout.trim() ? `stdout：${stdout.trim()}` : '',
    stderr.trim() ? `stderr：${stderr.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return (value || 'verifier 未输出内容').slice(-4_000)
}
