import { NativeBenchmarkAdapter } from '../../packages/eval-engine/src/adapters/benchmarks/native/native-benchmark.adapter.js'
import { InMemoryEvalRepository } from '../../packages/eval-engine/src/adapters/repositories/in-memory-eval.repository.js'
import { TemporaryWorkspaceFactory } from '../../packages/agent-runtime/src/workspace/temporary-workspace.js'
import { EvalRunner } from '../../packages/eval-engine/src/application/eval-runner.js'
import { loadNativeCaseFile } from '../../packages/eval-engine/src/adapters/benchmarks/native/native-case-loader.js'
import type { EvalCase } from '../../packages/eval-engine/src/domain/eval-case.js'
import type { AgentPort } from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import { createCodeDenAgent } from '../../packages/agent-runtime/src/create-codeden-runtime.js'
import type { ModelProvider } from '../../packages/agent-runtime/src/models/model-provider.js'
import {
  MockModelProvider,
  type MockModelStep,
} from '../../packages/agent-runtime/src/models/mock-model-provider.js'

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
