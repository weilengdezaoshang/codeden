import path from 'node:path'
import { loadNativeCaseFile } from '../eval/adapters/benchmarks/native/native-case-loader.js'
import { NativeBenchmarkAdapter } from '../eval/adapters/benchmarks/native/native-benchmark.adapter.js'
import { BenchmarkRegistry } from '../eval/adapters/benchmarks/benchmark-registry.js'
import { SweBenchAdapter } from '../eval/adapters/benchmarks/swebench/swebench.adapter.js'
import { JsonlEvalRepository } from '../eval/adapters/repositories/jsonl-eval.repository.js'
import { RepositoryWorkspaceFactory } from '../eval/adapters/workspaces/repository-workspace.factory.js'
import { EvalRunner } from '../eval/application/eval-runner.js'
import { DatasetCache } from '../eval/datasets/dataset-cache.js'
import { DatasetFetcher } from '../eval/datasets/dataset-fetcher.js'
import { assertDeclaredDatasetLicense } from '../eval/datasets/dataset-license-policy.js'
import { DatasetSourceSchema } from '../eval/datasets/dataset-source.js'
import { ConsoleReporter } from '../eval/reporters/console.reporter.js'
import { createCodeDenAgent } from '../runtime/create-codeden-runtime.js'
import {
  createEvalMockProvider,
  createModelProvider,
} from '../runtime/models/create-model-provider.js'
import { createSecurityServices } from '../security/security-services.js'
import { hasFlag, readFlag, readNumberFlag, readRepeatedFlag } from './args.js'

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const casePath = readFlag(argv, '--case')
  const benchmarkName = readFlag(argv, '--benchmark') ?? 'native'
  const datasetPath = readFlag(argv, '--dataset')
  if (!casePath && !datasetPath) {
    console.error(
      'Usage: pnpm eval --case <yaml> | --benchmark swebench-lite --dataset <jsonl> --limit <n> --version <version> --license <license> --sha256 <digest> --test-command <command> --allow-host-verification',
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
    let datasetVersion = 'native'
    let datasetLicense = 'native'
    let datasetSha256 = '0'.repeat(64)
    let swebench: SweBenchAdapter | undefined
    if (benchmarkName === 'swebench-lite') {
      datasetVersion = requiredFlag(argv, '--version')
      datasetLicense = requiredFlag(argv, '--license')
      datasetSha256 = requiredFlag(argv, '--sha256')
      assertDeclaredDatasetLicense(datasetLicense)
      swebench = new SweBenchAdapter({
        datasetVersion,
        license: datasetLicense,
        sha256: datasetSha256,
        verificationMode: 'host-opt-in',
        resolveVerificationCommand: (_record, tests) => ({
          command: testCommand ?? '',
          args: [...readRepeatedFlag(argv, '--test-arg'), ...tests],
        }),
      })
    }
    const registry = new BenchmarkRegistry(swebench ? [native, swebench] : [native])
    const benchmark = registry.get(benchmarkName)
    if (benchmarkName === 'swebench-lite' && (!testCommand || !allowHostVerification)) {
      throw new Error('SWE-bench requires --test-command and explicit --allow-host-verification')
    }
    let resolvedDatasetPath = datasetPath
    if (benchmarkName === 'swebench-lite') {
      const source = DatasetSourceSchema.parse({
        name: benchmarkName,
        version: datasetVersion,
        localPath: path.resolve(datasetPath!),
        license: datasetLicense,
        sha256: datasetSha256,
      })
      const cacheRoot = path.resolve(readFlag(argv, '--dataset-cache') ?? '.codeden/datasets')
      const fetched = await new DatasetFetcher(new DatasetCache(cacheRoot)).fetch(
        source,
        hasFlag(argv, '--offline'),
      )
      resolvedDatasetPath = fetched.path
    }
    const loadedCases = casePath
      ? [await loadNativeCaseFile(casePath)]
      : await collect(benchmark.load({ kind: 'file', path: resolvedDatasetPath! }))
    const limit = readNumberFlag(argv, '--limit', loadedCases.length || 1)
    const cases = limitCases(loadedCases, limit)
    const modelName = readFlag(argv, '--model') ?? 'mock'
    const security = createSecurityServices()
    const model =
      modelName === 'mock' ? createEvalMockProvider() : createModelProvider(modelName, { security })
    const resultsRoot = path.resolve(readFlag(argv, '--results-dir') ?? '.codeden/results')
    const repository = new JsonlEvalRepository(resultsRoot, security.guard)

    const runner = new EvalRunner({
      agent: createCodeDenAgent(model, undefined, security),
      benchmark,
      workspaceFactory: new RepositoryWorkspaceFactory({
        allowVerificationCommands: allowHostVerification,
        sandboxRedact: (value) => security.redactor.redact(value),
      }),
      repository,
      reporter: new ConsoleReporter(console.log, security.redactor, security.guard),
      security,
    })

    const summary = await runner.run(cases)
    console.log(`Results: ${path.join(resultsRoot, `${summary.runId}.jsonl`)}`)
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

export function limitCases<T>(cases: T[], limit: number): T[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid --limit: ${limit}`)
  }
  return cases.slice(0, limit)
}

function requiredFlag(argv: string[], name: string): string {
  const value = readFlag(argv, name)
  if (!value) {
    throw new Error(`SWE-bench requires ${name}`)
  }
  return value
}

const isDirect = process.argv[1]?.includes('eval-command')
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(2),
  )
}
