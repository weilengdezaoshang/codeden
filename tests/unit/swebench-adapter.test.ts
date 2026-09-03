import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SweBenchAdapter } from '../../packages/eval-engine/src/adapters/benchmarks/swebench/swebench.adapter.js'
import { loadSweBenchRecords } from '../../packages/eval-engine/src/adapters/benchmarks/swebench/swebench.loader.js'

const record = {
  instance_id: 'django__django-11099',
  repo: 'django/django',
  base_commit: 'abc123',
  problem_statement: 'Fix the reported regression.',
  hints_text: '',
  patch: '',
  test_patch: ['diff --git a/test.py b/test.py', '--- a/test.py', '+++ b/test.py'].join('\n'),
  version: '3.0',
  FAIL_TO_PASS: '["tests/test_regression.py::test_case"]',
  PASS_TO_PASS: '[]',
}

async function fixtureFile(content: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codeden-swebench-'))
  const file = path.join(root, 'dataset.jsonl')
  await writeFile(file, content)
  return file
}

describe('测试套件：SWE-bench adapter', () => {
  it('验证：loads JSONL and normalizes encoded test lists', async () => {
    const file = await fixtureFile(
      `${JSON.stringify(record)}\n${JSON.stringify({ ...record, instance_id: 'case-2' })}\n`,
    )
    const records = await loadSweBenchRecords(file)
    expect(records).toHaveLength(2)
    expect(records[0]?.FAIL_TO_PASS).toEqual(['tests/test_regression.py::test_case'])
  })

  it('验证：maps upstream repository and test metadata into EvalCase', async () => {
    const file = await fixtureFile(JSON.stringify([record]))
    const adapter = new SweBenchAdapter({
      datasetVersion: 'lite-1.0',
      license: 'MIT',
      sha256: 'a'.repeat(64),
      verificationMode: 'host-opt-in',
      resolveVerificationCommand: (_input, tests) => ({
        command: 'python',
        args: ['-m', 'pytest', ...tests],
      }),
    })
    const cases = []
    for await (const evalCase of adapter.load({ kind: 'file', path: file })) {
      cases.push(evalCase)
    }

    expect(cases).toHaveLength(1)
    expect(cases[0]?.fixture.repository).toMatchObject({
      repository: 'django/django',
      baseCommit: 'abc123',
      testPatch: ['diff --git a/test.py b/test.py', '--- a/test.py', '+++ b/test.py'].join('\n'),
    })
    expect(cases[0]?.metadata).toMatchObject({
      source: 'swebench-lite',
      repository: 'django/django',
      baseCommit: 'abc123',
      sha256: 'a'.repeat(64),
      verificationMode: 'host-opt-in',
    })
    expect(cases[0]?.task.taskSpec.verificationCommands).toEqual([
      'python -m pytest tests/test_regression.py::test_case',
    ])
    expect(cases[0]?.verification.graders).toEqual([
      { type: 'unchanged-paths', paths: ['test.py'] },
      {
        type: 'command',
        command: 'python',
        args: ['-m', 'pytest', 'tests/test_regression.py::test_case'],
        timeoutMs: 300_000,
      },
    ])
  })

  it('验证：reports the failing JSONL line', async () => {
    const file = await fixtureFile(`${JSON.stringify(record)}\n{"instance_id": 42}\n`)
    await expect(loadSweBenchRecords(file)).rejects.toThrow('line 2')
  })
})
