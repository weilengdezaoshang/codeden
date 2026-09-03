import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TerminalBenchAdapter } from '../../packages/eval-engine/src/adapters/benchmarks/terminalbench/terminalbench.adapter.js'
import { loadTerminalBenchTasks } from '../../packages/eval-engine/src/adapters/benchmarks/terminalbench/terminalbench.loader.js'

describe('Terminal-Bench 适配器', () => {
  it('加载 task.toml 目录但不把 solution 作为 Agent 输入', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-terminal-bench-test-'))
    const task = path.join(root, 'hello-world')
    await mkdir(path.join(task, 'environment'), { recursive: true })
    await mkdir(path.join(task, 'tests'), { recursive: true })
    await mkdir(path.join(task, 'solution'), { recursive: true })
    await writeFile(path.join(task, 'instruction.md'), '创建 hello.txt\n内容必须是 hello\n')
    await writeFile(path.join(task, 'task.toml'), '[environment]\ndocker_image = "tb:test"\n')
    await writeFile(path.join(task, 'environment', 'Dockerfile'), 'FROM alpine:3.20\n')
    await writeFile(path.join(task, 'tests', 'test.sh'), '#!/bin/sh\ntest -f hello.txt\n')
    await writeFile(path.join(task, 'solution', 'solve.sh'), '#!/bin/sh\n')
    try {
      const tasks = await loadTerminalBenchTasks(root)
      expect(tasks).toMatchObject([
        {
          id: 'hello-world',
          verifierScript: 'tests/test.sh',
          environmentImage: 'tb:test',
        },
      ])
      const adapter = new TerminalBenchAdapter({
        datasetVersion: '2.0',
        license: 'apache-2.0',
        sha256: 'c'.repeat(64),
      })
      const cases = []
      for await (const evalCase of adapter.load({ kind: 'directory', path: root })) {
        cases.push(evalCase)
      }
      expect(cases[0]).toMatchObject({
        id: 'hello-world',
        fixture: { path: task },
        metadata: { image: 'tb:test', verifierScript: 'tests/test.sh' },
        submission: { type: 'files' },
      })
      expect(JSON.stringify(cases[0])).not.toContain('solve.sh')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('把 verifier 退出码统一为 passed/failed', async () => {
    const adapter = new TerminalBenchAdapter({
      datasetVersion: '2.0',
      license: 'apache-2.0',
      sha256: 'd'.repeat(64),
    })
    const evalCase = {
      schemaVersion: 1 as const,
      id: 'task',
      suite: 'validation' as const,
      tags: [],
      metadata: { source: 'terminal-bench', verifierScript: 'tests/test.sh' },
      task: {
        prompt: '完成任务',
        taskSpec: {
          id: 'task',
          goal: '完成任务',
          acceptanceCriteria: ['通过'],
          constraints: [],
          allowedPaths: ['.'],
          verificationCommands: ['bash .codeden-verifier-tests/tests/test.sh'],
          verificationPlan: {
            schemaVersion: 1 as const,
            steps: [
              {
                id: 'terminal-bench-verifier',
                kind: 'test' as const,
                source: 'system' as const,
                required: true,
                timeoutMs: 1_000,
                command: 'bash .codeden-verifier-tests/tests/test.sh',
              },
            ],
          },
        },
      },
      fixture: { path: '/tmp/task' },
      limits: { timeoutMs: 1_000, maxTurns: 1, maxToolCalls: 1 },
      submission: { type: 'files' as const, allowedPaths: ['.'] },
      verification: { graders: [{ type: 'terminal-bench' }] },
    }
    const prepared = await adapter.prepare(evalCase, {} as never)
    const passed = await adapter.verify(prepared, undefined, {
      workspace: {
        exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
      } as never,
      runId: 'run',
      trialId: 'trial',
    })
    const failed = await adapter.verify(prepared, undefined, {
      workspace: {
        exec: async () => ({ exitCode: 1, stdout: '', stderr: 'bad', durationMs: 1 }),
      } as never,
      runId: 'run',
      trialId: 'trial',
    })
    expect(passed).toMatchObject({ status: 'passed', scores: { 'terminal-bench:1': 1 } })
    expect(failed).toMatchObject({ status: 'failed', scores: { 'terminal-bench:1': 0 } })
  })
})
