import { NativeBenchmarkAdapter } from '../../src/eval/adapters/benchmarks/native/native-benchmark.adapter.js'
import { InMemoryEvalRepository } from '../../src/eval/adapters/repositories/in-memory-eval.repository.js'
import { TemporaryWorkspaceFactory } from '../../src/eval/adapters/workspaces/temporary-workspace.adapter.js'
import { EvalRunner } from '../../src/eval/application/eval-runner.js'
import { loadNativeCaseFile } from '../../src/eval/adapters/benchmarks/native/native-case-loader.js'
import type { EvalCase } from '../../src/eval/domain/eval-case.js'
import type { AgentPort } from '../../src/eval/ports/agent.port.js'
import { createCodeDenAgent } from '../../src/runtime/create-codeden-runtime.js'
import type { ModelProvider } from '../../src/runtime/models/model-provider.js'
import {
  MockModelProvider,
  type MockModelStep,
} from '../../src/runtime/models/mock-model-provider.js'

export const CASE_PATH = 'evals/cases/regression/update-package-version.yaml'

export async function loadDemoCase(): Promise<EvalCase> {
  return loadNativeCaseFile(CASE_PATH)
}

export async function runEvalWithModel(model: ModelProvider) {
  const repository = new InMemoryEvalRepository()
  const runner = new EvalRunner({
    agent: createCodeDenAgent(model),
    benchmark: new NativeBenchmarkAdapter(),
    workspaceFactory: new TemporaryWorkspaceFactory(),
    repository,
  })
  const evalCase = await loadDemoCase()
  const summary = await runner.run([evalCase])
  const trial = summary.trials[0]
  if (!trial) {
    throw new Error('missing trial')
  }
  return { summary, trial, repository }
}

export function mockFromSteps(steps: MockModelStep[]): MockModelProvider {
  return new MockModelProvider(steps)
}

export async function runEvalWithAgent(agent: AgentPort) {
  const repository = new InMemoryEvalRepository()
  const runner = new EvalRunner({
    agent,
    benchmark: new NativeBenchmarkAdapter(),
    workspaceFactory: new TemporaryWorkspaceFactory(),
    repository,
  })
  const summary = await runner.run([await loadDemoCase()])
  const trial = summary.trials[0]
  if (!trial) {
    throw new Error('missing trial')
  }
  return { summary, trial, repository }
}
