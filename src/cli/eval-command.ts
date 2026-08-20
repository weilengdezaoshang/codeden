import { loadNativeCaseFile } from '../eval/adapters/benchmarks/native/native-case-loader.js'
import { NativeBenchmarkAdapter } from '../eval/adapters/benchmarks/native/native-benchmark.adapter.js'
import { InMemoryEvalRepository } from '../eval/adapters/repositories/in-memory-eval.repository.js'
import { TemporaryWorkspaceFactory } from '../eval/adapters/workspaces/temporary-workspace.adapter.js'
import { EvalRunner } from '../eval/application/eval-runner.js'
import { ConsoleReporter } from '../eval/reporters/console.reporter.js'
import { createCodeDenAgent } from '../runtime/create-codeden-runtime.js'
import {
  createEvalMockProvider,
  createModelProvider,
} from '../runtime/models/create-model-provider.js'
import { createSecurityServices } from '../security/security-services.js'
import { readFlag } from './args.js'

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const casePath = readFlag(argv, '--case')
  if (!casePath) {
    console.error('Usage: pnpm eval --case <path-to-yaml> [--model mock|openai|deepseek|grok]')
    return 2
  }

  try {
    const evalCase = await loadNativeCaseFile(casePath)
    const modelName = readFlag(argv, '--model') ?? 'mock'
    const security = createSecurityServices()
    const model =
      modelName === 'mock' ? createEvalMockProvider() : createModelProvider(modelName, { security })

    const runner = new EvalRunner({
      agent: createCodeDenAgent(model, undefined, security),
      benchmark: new NativeBenchmarkAdapter(),
      workspaceFactory: new TemporaryWorkspaceFactory(),
      repository: new InMemoryEvalRepository(security.guard),
      reporter: new ConsoleReporter(console.log, security.redactor, security.guard),
      security,
    })

    const summary = await runner.run([evalCase])
    if (summary.infrastructureFailed) {
      return 2
    }
    return summary.allResolved ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    return 2
  }
}

const isDirect = process.argv[1]?.includes('eval-command')
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(2),
  )
}
