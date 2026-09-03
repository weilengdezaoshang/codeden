import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseEvalCase, type EvalCase } from '../../../domain/eval-case.js'
import type { BenchmarkSource } from '../../../ports/benchmark.port.js'

export async function loadNativeCases(source: BenchmarkSource): Promise<EvalCase[]> {
  if (source.kind === 'file') {
    return [await loadNativeCaseFile(source.path)]
  }

  const entries = await readdir(source.path)
  const files = entries
    .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
    .map((entry) => path.join(source.path, entry))
    .sort()

  const cases: EvalCase[] = []
  for (const file of files) {
    const info = await stat(file)
    if (info.isFile()) {
      cases.push(await loadNativeCaseFile(file))
    }
  }
  return cases
}

export async function loadNativeCaseFile(filePath: string): Promise<EvalCase> {
  const raw = await readFile(filePath, 'utf8')
  const parsed: unknown = parseYaml(raw)
  const evalCase = parseEvalCase(parsed)
  return {
    ...evalCase,
    fixture: {
      path: path.resolve(path.dirname(filePath), evalCase.fixture.path),
    },
  }
}
