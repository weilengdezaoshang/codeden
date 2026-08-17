import type { AgentSubmission } from '../../../domain/agent-submission.js'
import type { EvalCase } from '../../../domain/eval-case.js'
import type { VerificationResult } from '../../../domain/verification-result.js'
import { CompositeGrader } from '../../../graders/composite.grader.js'
import type {
  BenchmarkPort,
  BenchmarkSource,
  PreparedCase,
  VerificationContext,
} from '../../../ports/benchmark.port.js'
import type { WorkspacePort } from '../../../ports/workspace.port.js'
import { loadNativeCases } from './native-case-loader.js'

export class NativeBenchmarkAdapter implements BenchmarkPort {
  readonly name = 'native'
  private readonly graders: CompositeGrader

  constructor(graders = new CompositeGrader()) {
    this.graders = graders
  }

  async *load(source: BenchmarkSource): AsyncIterable<EvalCase> {
    const cases = await loadNativeCases(source)
    for (const evalCase of cases) {
      yield evalCase
    }
  }

  async prepare(evalCase: EvalCase, workspace: WorkspacePort): Promise<PreparedCase> {
    return {
      evalCase,
      workspace,
      agentTask: {
        prompt: evalCase.task.prompt,
        taskSpec: evalCase.task.taskSpec,
      },
    }
  }

  async verify(
    preparedCase: PreparedCase,
    submission: AgentSubmission | undefined,
    context: VerificationContext,
  ): Promise<VerificationResult> {
    return this.graders.gradeAll(preparedCase.evalCase.verification.graders, {
      workspace: context.workspace,
      submission,
    })
  }
}
