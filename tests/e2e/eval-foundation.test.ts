import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeBenchmarkAdapter } from '../../src/eval/adapters/benchmarks/native/native-benchmark.adapter.js'
import { TemporaryWorkspaceFactory } from '../../src/eval/adapters/workspaces/temporary-workspace.adapter.js'
import { EvalRunner } from '../../src/eval/application/eval-runner.js'
import type { BenchmarkPort } from '../../src/eval/ports/benchmark.port.js'
import { createCodeDenAgent } from '../../src/runtime/create-codeden-runtime.js'
import { finalText, toolCall } from '../../src/runtime/models/mock-model-provider.js'
import {
  loadDemoCase,
  mockFromSteps,
  runEvalWithAgent,
  runEvalWithModel,
} from '../helpers/eval-harness.js'

const successSteps = [
  toolCall('read_file', { path: 'package.json' }),
  toolCall('edit_file', {
    path: 'package.json',
    oldText: '"version": "1.0.0"',
    newText: '"version": "2.0.0"',
  }),
  finalText('已完成版本修改'),
]

describe('E2E eval foundation', () => {
  it('E2E-1: happy path is resolved', async () => {
    const fixtureOriginal = await readFile('evals/fixtures/basic-node-project/package.json', 'utf8')
    const { trial, repository } = await runEvalWithModel(mockFromSteps(successSteps))
    expect(trial.execution.status).toBe('submitted')
    expect(trial.submission.status).toBe('valid')
    expect(trial.verification.status).toBe('passed')
    expect(trial.resolved).toBe(true)
    expect(trial.failure).toBeUndefined()
    expect(trial.metrics.turns).toBe(3)
    expect(trial.metrics.toolCalls).toBe(2)
    const events = await repository.getEvents(trial.trialId)
    expect(events.map((event) => event.type)).toContain('eval.trial.started')
    expect(events.map((event) => event.type)).toContain('tool.completed')
    expect(events.map((event) => event.type)).toContain('eval.trial.completed')
    expect(events.every((event, index) => event.sequence === index)).toBe(true)
    expect(await readFile('evals/fixtures/basic-node-project/package.json', 'utf8')).toBe(
      fixtureOriginal,
    )
  })

  it('E2E-2: model claims completion without edits', async () => {
    const { trial } = await runEvalWithModel(mockFromSteps([finalText('已完成')]))
    expect(trial.execution.status).toBe('submitted')
    expect(['empty', 'valid']).toContain(trial.submission.status)
    expect(trial.verification.status).toBe('failed')
    expect(trial.resolved).toBe(false)
    expect(trial.failure?.category).toBe('submission')
  })

  it('E2E-3: out-of-workspace write is denied', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'codeden-outside-e2e-'))
    const outsideFile = path.join(outsideDir, 'secret.txt')
    await writeFile(outsideFile, 'keep', 'utf8')
    const { trial, repository } = await runEvalWithModel(
      mockFromSteps([
        toolCall('write_file', { path: outsideFile, content: 'hacked' }),
        finalText('done'),
      ]),
    )
    expect(trial.resolved).toBe(false)
    const events = await repository.getEvents(trial.trialId)
    expect(events.some((event) => event.type === 'tool.failed')).toBe(true)
    expect(await readFile(outsideFile, 'utf8')).toBe('keep')
  })

  it('E2E-4: extra file change fails changed-paths', async () => {
    const { trial, repository } = await runEvalWithModel(
      mockFromSteps([
        toolCall('edit_file', {
          path: 'package.json',
          oldText: '"version": "1.0.0"',
          newText: '"version": "2.0.0"',
        }),
        toolCall('write_file', { path: 'README.md', content: 'extra' }),
        toolCall('run_command', {
          command: process.execPath,
          args: ['-e', "require('fs').writeFileSync('README.md', 'extra')"],
        }),
        finalText('done'),
      ]),
    )
    const events = await repository.getEvents(trial.trialId)
    expect(
      events.some(
        (event) =>
          event.type === 'tool.failed' &&
          typeof event.data === 'object' &&
          event.data !== null &&
          'toolName' in event.data &&
          event.data.toolName === 'write_file',
      ),
    ).toBe(true)
    expect(trial.scores['json-field:1']).toBe(1)
    expect(trial.scores['changed-paths:2']).toBe(0)
    expect(trial.verification.status).toBe('failed')
    expect(trial.resolved).toBe(false)
  })

  it('E2E-5: agent timeout is not a verifier failure and still persists', async () => {
    let disposed = false
    const factory = new TemporaryWorkspaceFactory()
    const originalCreate = factory.create.bind(factory)
    factory.create = async (fixture) => {
      const workspace = await originalCreate(fixture)
      const dispose = workspace.dispose.bind(workspace)
      workspace.dispose = async () => {
        disposed = true
        await dispose()
      }
      return workspace
    }

    const repository = (
      await import('../../src/eval/adapters/repositories/in-memory-eval.repository.js')
    ).InMemoryEvalRepository
    const repo = new repository()
    const runner = new EvalRunner({
      agent: createCodeDenAgent({
        name: 'hang',
        complete: () => new Promise(() => undefined),
      }),
      benchmark: new NativeBenchmarkAdapter(),
      workspaceFactory: factory,
      repository: repo,
    })
    const evalCase = await loadDemoCase()
    evalCase.limits.timeoutMs = 40
    const summary = await runner.run([evalCase])
    const trial = summary.trials[0]!
    expect(trial.execution.status).toBe('timeout')
    expect(trial.verification.status).toBe('error')
    expect(trial.verification.status).not.toBe('failed')
    expect(trial.failure?.category).toBe('timeout')
    expect(disposed).toBe(true)
    expect(await repo.getTrial(trial.trialId)).not.toBeNull()
  })

  it('E2E-6: verifier exceptions stay separate from agent status', async () => {
    const inner = new NativeBenchmarkAdapter()
    const benchmark: BenchmarkPort = {
      name: 'native-throwing',
      load: (source) => inner.load(source),
      prepare: (evalCase, workspace) => inner.prepare(evalCase, workspace),
      async verify() {
        throw new Error('grader exploded')
      },
    }
    const { trial } = await runEvalWithAgent(createCodeDenAgent(mockFromSteps(successSteps)))
    expect(trial.execution.status).toBe('submitted')

    const repo = new (
      await import('../../src/eval/adapters/repositories/in-memory-eval.repository.js')
    ).InMemoryEvalRepository()
    const runner = new EvalRunner({
      agent: createCodeDenAgent(mockFromSteps(successSteps)),
      benchmark,
      workspaceFactory: new TemporaryWorkspaceFactory(),
      repository: repo,
    })
    const summary = await runner.run([await loadDemoCase()])
    const verified = summary.trials[0]!
    expect(verified.execution.status).toBe('submitted')
    expect(verified.verification.status).toBe('error')
    expect(verified.resolved).toBe(false)
    expect(verified.infrastructure.status).toBe('ok')
    expect(verified.failure?.category).toBe('verification')
  })
})
