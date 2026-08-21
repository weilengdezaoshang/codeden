import { loadNativeCaseFile } from '../eval/adapters/benchmarks/native/native-case-loader.js'
import { NativeBenchmarkAdapter } from '../eval/adapters/benchmarks/native/native-benchmark.adapter.js'
import { BenchmarkRegistry } from '../eval/adapters/benchmarks/benchmark-registry.js'
import { SweBenchAdapter } from '../eval/adapters/benchmarks/swebench/swebench.adapter.js'
import { InMemoryEvalRepository } from '../eval/adapters/repositories/in-memory-eval.repository.js'
import { RepositoryWorkspaceFactory } from '../eval/adapters/workspaces/repository-workspace.factory.js'
import { EvalRunner } from '../eval/application/eval-runner.js'
import { ConsoleReporter } from '../eval/reporters/console.reporter.js'
import { createCodeDenAgent } from '../runtime/create-codeden-runtime.js'
import {
  createEvalMockProvider,
  createModelProvider,
} from '../runtime/models/create-model-provider.js'
import { createSecurityServices } from '../security/security-services.js'
import { hasFlag, readFlag, readRepeatedFlag } from './args.js'

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const casePath = readFlag(argv, '--case')
  const benchmarkName = readFlag(argv, '--benchmark') ?? 'native'
  const datasetPath = readFlag(argv, '--dataset')
  if (!casePath && !datasetPath) {
    console.error(
      'Usage: pnpm eval --case <yaml> | --benchmark swebench-lite --dataset <jsonl> --version <version> --license <license> --test-command <command> --allow-host-verification',
    )
    return 2
  }
  if (casePath && datasetPath) {
    console.error('Use either --case or --dataset, not both')
    return 2
  }
  if (casePath && benchmarkName !== 'native') {
    console.error('--case can only be used with the native benchmark')
    return 2
  }
  if (datasetPath && benchmarkName === 'native') {
    console.error('--dataset requires an explicit --benchmark')
    return 2
  }

  try {
    const native = new NativeBenchmarkAdapter()
    const testCommand = readFlag(argv, '--test-command')
    const allowHostVerification = hasFlag(argv, '--allow-host-verification')
    const swebench = new SweBenchAdapter({
      datasetVersion: requiredFlag(argv, '--version', benchmarkName),
      license: requiredFlag(argv, '--license', benchmarkName),
      resolveVerificationCommand: (_record, tests) => ({
        command: testCommand ?? '',
        args: [...readRepeatedFlag(argv, '--test-arg'), ...tests],
      }),
    })
    const registry = new BenchmarkRegistry([native, swebench])
    const benchmark = registry.get(benchmarkName)
    if (benchmarkName === 'swebench-lite' && (!testCommand || !allowHostVerification)) {
      throw new Error('SWE-bench requires --test-command and explicit --allow-host-verification')
    }
    const cases = casePath
      ? [await loadNativeCaseFile(casePath)]
      : await collect(benchmark.load({ kind: 'file', path: datasetPath! }))
    const modelName = readFlag(argv, '--model') ?? 'mock'
    const security = createSecurityServices()
    const model =
      modelName === 'mock' ? createEvalMockProvider() : createModelProvider(modelName, { security })

    const runner = new EvalRunner({
      agent: createCodeDenAgent(model, undefined, security),
      benchmark,
      workspaceFactory: new RepositoryWorkspaceFactory({
        allowVerificationCommands: allowHostVerification,
      }),
      repository: new InMemoryEvalRepository(security.guard),
      reporter: new ConsoleReporter(console.log, security.redactor, security.guard),
      security,
    })

    const summary = await runner.run(cases)
    if (summary.infrastructureFailed) {
      return 2
    }
    return summary.allResolved ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    return 2
  }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) {
    result.push(item)
  }
  return result
}

function requiredFlag(argv: string[], name: string, benchmark: string): string {
  const value = readFlag(argv, name)
  if (benchmark === 'swebench-lite' && !value) {
    throw new Error(`SWE-bench requires ${name}`)
  }
  return value ?? 'native'
}

const isDirect = process.argv[1]?.includes('eval-command')
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(2),
  )
}
