import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SwePolyBenchAdapter } from '../../packages/eval-engine/src/adapters/benchmarks/swepolybench/swepolybench.adapter.js'

describe('SWE-PolyBench 适配器', () => {
  it('解析多语言实例、JSON 字符串测试列表和测试补丁保护路径', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-polybench-test-'))
    const file = path.join(root, 'dataset.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({
        instance_id: 'google__gson-2337',
        repo: 'google/gson',
        base_commit: 'a'.repeat(40),
        problem_statement: '修复 Gson 的序列化问题',
        language: 'Java',
        Dockerfile: 'FROM eclipse-temurin:17',
        test_command: 'mvn -q test',
        f2p: '["com.google.gson.GsonTest#serialize"]',
        p2p: ['com.google.gson.GsonTest#parse'],
        test_patch:
          'diff --git a/src/test/GsonTest.java b/src/test/GsonTest.java\n+++ b/src/test/GsonTest.java',
      })}\n`,
      'utf8',
    )
    try {
      const adapter = new SwePolyBenchAdapter({
        datasetVersion: '1.1',
        license: 'cc-by-nc-4.0',
        sha256: 'b'.repeat(64),
        verificationMode: 'isolated',
        imageFor: (record) => `example/${record.instance_id}:v1.1`,
      })
      const cases = []
      for await (const evalCase of adapter.load({ kind: 'file', path: file })) {
        cases.push(evalCase)
      }
      expect(cases).toHaveLength(1)
      expect(cases[0]).toMatchObject({
        id: 'google__gson-2337',
        tags: ['swe-polybench', 'java', 'google/gson'],
        metadata: {
          language: 'Java',
          image: 'example/google__gson-2337:v1.1',
          verificationMode: 'isolated',
        },
        fixture: { repository: { repository: 'google/gson', testPatch: expect.any(String) } },
        verification: {
          graders: expect.arrayContaining([
            expect.objectContaining({ type: 'unchanged-paths', paths: ['src/test/GsonTest.java'] }),
            expect.objectContaining({ type: 'command', command: 'mvn', args: ['-q', 'test'] }),
          ]),
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
