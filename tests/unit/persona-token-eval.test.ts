import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { InMemoryEvalRepository } from '../../src/eval/adapters/repositories/in-memory-eval.repository.js'
import { TrialRunner } from '../../src/eval/application/trial-runner.js'
import { parseEvalCase } from '../../src/eval/domain/eval-case.js'
import { emptyMetrics } from '../../src/eval/domain/metrics.js'
import { summarize } from '../../src/eval/application/eval-runner.js'
import type { AgentPort } from '../../src/eval/ports/agent.port.js'
import type { BenchmarkPort } from '../../src/eval/ports/benchmark.port.js'
import type { WorkspaceFactory, WorkspacePort } from '../../src/eval/ports/workspace.port.js'
import { NativeBenchmarkAdapter } from '../../src/eval/adapters/benchmarks/native/native-benchmark.adapter.js'
import { createCodeDenAgent } from '../../src/runtime/create-codeden-runtime.js'
import { TokenBudgetGrader } from '../../src/eval/graders/token-budget.grader.js'
import { TrialMetricsSink } from '../../src/eval/application/trial-metrics-sink.js'
import {
  MockModelProvider,
  finalText,
  toolCall,
} from '../../src/runtime/models/mock-model-provider.js'

afterEach(() => vi.restoreAllMocks())

describe('测试套件：人格与 Token 评测接线', () => {
  it('离线评测的父子任务不读取用户和父目录人格，正常交互仍读取用户人格', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codeden-persona-policy-'))
    try {
      const fixture = path.join(root, 'fixture')
      await mkdir(path.join(root, '.codeden'))
      await mkdir(path.join(root, '.git'))
      await mkdir(fixture)
      await writeFile(path.join(root, '.codeden', 'SOUL.md'), '用户人格标记')
      await writeFile(path.join(root, 'SOUL.md'), '父目录人格标记')
      await writeFile(path.join(fixture, 'SOUL.md'), '样本人格标记')
      vi.spyOn(os, 'homedir').mockReturnValue(root)
      const workspace = { ...fakeWorkspace(), root: fixture }
      const model = new MockModelProvider([
        toolCall('subagent', { prompt: '只读检查', readOnly: true }),
        finalText('已检查'),
        finalText('完成'),
      ])
      const requests = vi.spyOn(model, 'complete')
      const runner = new TrialRunner({
        repository: new InMemoryEvalRepository(),
        agent: createCodeDenAgent(model),
        benchmark: new NativeBenchmarkAdapter(),
        workspaceFactory: { create: async () => workspace },
      })
      await runner.run({ runId: 'isolated', evalCase: evalCase() })
      expect(requests).toHaveBeenCalledTimes(3)
      for (const [request] of requests.mock.calls) {
        const text = JSON.stringify(request.messages)
        expect(text).toContain('样本人格标记')
        expect(text).not.toContain('用户人格标记')
        expect(text).not.toContain('父目录人格标记')
      }
      await writeFile(path.join(root, '.codeden', 'SOUL.md'), '变更后的用户人格标记')
      const interactive = new MockModelProvider([finalText('完成')])
      const interactiveRequests = vi.spyOn(interactive, 'complete')
      await createCodeDenAgent(interactive).run(evalCase().task, {
        runId: 'interactive',
        trialId: 'interactive',
        workspace,
        eventSink: new NoopEventSink(),
        limits: { maxTurns: 1, maxToolCalls: 1 },
        submissionType: 'text',
      })
      expect(JSON.stringify(interactiveRequests.mock.calls[0]?.[0].messages)).toContain(
        '变更后的用户人格标记',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('异常抛出仍保留父子模型消耗，按请求去重并忽略迟到事件', async () => {
    const sink = new TrialMetricsSink(new NoopEventSink())
    for (const agentSpanId of ['parent', 'child']) {
      for (let i = 0; i < 2; i++) {
        await sink.emit('model', 'model.requested', { agentSpanId, turn: 1 })
        await sink.emit('model', 'model.completed', {
          agentSpanId,
          turn: 1,
          usage: { inputTokens: 10, outputTokens: 5 },
        })
      }
    }
    sink.close()
    await sink.emit('model', 'model.requested', { agentSpanId: 'late', turn: 1 })
    expect(sink.snapshot()).toMatchObject({
      modelRequests: 2,
      inputTokens: 20,
      outputTokens: 10,
      tokenUsage: { measuredRequests: 2, status: 'partial', collectionComplete: false },
    })
    const runner = new TrialRunner({
      repository: new InMemoryEvalRepository(),
      benchmark: new NativeBenchmarkAdapter(),
      workspaceFactory: { create: async () => fakeWorkspace() },
      agent: {
        name: '异常代理',
        async run(_task, context) {
          await context.eventSink.emit('model', 'model.requested', { turn: 1 })
          await context.eventSink.emit('model', 'model.completed', {
            turn: 1,
            usage: { inputTokens: 10, outputTokens: 5 },
          })
          throw new Error('异常退出')
        },
      },
    })
    const result = await runner.run({ runId: 'error', evalCase: evalCase() })
    expect(result.metrics).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      tokenUsage: { collectionComplete: false },
    })
  })

  it('尚未发出请求就异常退出时，混合汇总也不能声称完整', async () => {
    const runner = new TrialRunner({
      repository: new InMemoryEvalRepository(),
      benchmark: new NativeBenchmarkAdapter(),
      workspaceFactory: { create: async () => fakeWorkspace() },
      agent: {
        name: '静默异常',
        async run() {
          throw new Error('未返回结果')
        },
      },
    })
    const unknown = await runner.run({ runId: 'unknown', evalCase: evalCase() })
    expect(unknown.metrics.tokenUsage).toMatchObject({
      totalRequests: 0,
      collectionComplete: false,
    })
    const healthy = {
      ...unknown,
      metrics: emptyMetrics({
        modelRequests: 1,
        inputTokens: 10,
        outputTokens: 5,
        tokenUsage: { status: 'complete', totalRequests: 1, measuredRequests: 1 },
      }),
    }
    const summary = summarize('mixed', [unknown, healthy], 1)
    expect(summary.tokenUsageCoverage).toBe(0)
    expect(summary.inputTokens + summary.outputTokens).toBe(15)
  })
  it('不响应取消的任务保留已记录消耗，并且混合汇总不能声称计量完整', async () => {
    const repository = new InMemoryEvalRepository()
    const runner = new TrialRunner({
      repository,
      benchmark: new NativeBenchmarkAdapter(),
      workspaceFactory: { create: async () => fakeWorkspace() },
      agent: {
        name: '不响应取消',
        async run(_task, context) {
          await context.eventSink.emit('model', 'model.requested', { turn: 1 })
          await context.eventSink.emit('model', 'model.completed', {
            turn: 1,
            usage: { inputTokens: 100, outputTokens: 50 },
          })
          await context.eventSink.emit('model', 'model.requested', { turn: 2 })
          return new Promise(() => {})
        },
      },
    })
    const value = evalCase()
    value.limits.timeoutMs = 10
    const timeout = await runner.run({ runId: 'timeout-run', evalCase: value })
    expect(timeout.metrics).toMatchObject({
      modelRequests: 2,
      inputTokens: 100,
      outputTokens: 50,
      tokenUsage: { status: 'partial', collectionComplete: false },
    })
    const healthy = {
      ...timeout,
      metrics: emptyMetrics({
        modelRequests: 1,
        inputTokens: 100,
        outputTokens: 50,
        tokenUsage: { status: 'complete', measuredRequests: 1, totalRequests: 1 },
      }),
    }
    const summary = summarize('mixed-run', [timeout, healthy], 1)
    expect(summary.inputTokens + summary.outputTokens).toBe(300)
    expect(summary.tokenUsageCoverage).toBeLessThan(1)
  })
  it('真实 Agent 循环同时产出人格评分、Token 评分和可定位 Prompt 事件', async () => {
    const repository = new InMemoryEvalRepository()
    const value = evalCase()
    value.verification.graders = [
      {
        type: 'persona-rubric',
        criteria: [
          { id: 'concise', kind: 'max_chars', value: 20 },
          { id: 'polite', kind: 'contains', value: '请' },
        ],
      },
      { type: 'token-budget', maxTokens: 20, maxRequests: 1 },
    ]
    const runner = new TrialRunner({
      repository,
      agent: createCodeDenAgent(new MockModelProvider([finalText('请运行测试。')])),
      benchmark: new NativeBenchmarkAdapter(),
      workspaceFactory: { create: async () => fakeWorkspace() },
    })
    const result = await runner.run({ runId: 'real-run', evalCase: value })
    expect(result.resolved).toBe(true)
    expect(result.scores).toMatchObject({ 'persona-rubric:1': 1, 'token-budget:2': 1 })
    const events = await repository.getEvents(result.trialId)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.prompt_composed',
        data: expect.objectContaining({
          hasPersona: true,
          personaDigest: expect.any(String),
          promptDigest: expect.any(String),
        }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.completed',
        data: expect.objectContaining({
          metrics: expect.objectContaining({
            tokenUsage: { status: 'complete', measuredRequests: 1, totalRequests: 1 },
          }),
        }),
      }),
    )
  })

  it('子 Agent 消耗计入根任务且保持独立链路标识', async () => {
    const repository = new InMemoryEvalRepository()
    const model = new MockModelProvider([
      toolCall('subagent', { prompt: '只读检查', readOnly: true }),
      finalText('已检查'),
      finalText('完成'),
    ])
    const value = evalCase()
    value.verification.graders = [{ type: 'token-budget', maxTokens: 100 }]
    const runner = new TrialRunner({
      repository,
      agent: createCodeDenAgent(model),
      benchmark: new NativeBenchmarkAdapter(),
      workspaceFactory: { create: async () => fakeWorkspace() },
    })
    const result = await runner.run({ runId: 'child-run', evalCase: value })
    expect(result.metrics.modelRequests).toBe(3)
    expect(result.metrics.inputTokens + result.metrics.outputTokens).toBe(42)
    const completed = (await repository.getEvents(result.trialId)).filter(
      (event) => event.type === 'agent.completed',
    )
    expect(completed).toHaveLength(2)
    expect(completed[0]?.data).toMatchObject({ agentDepth: 1 })
    expect(completed[1]?.data).toMatchObject({ agentDepth: 0 })
  })

  it('Token 预算评分覆盖上限、超限和缺失计量', async () => {
    const grader = new TokenBudgetGrader(),
      workspace = fakeWorkspace()
    const metrics = emptyMetrics({
      modelRequests: 1,
      inputTokens: 10,
      outputTokens: 5,
      tokenUsage: { status: 'complete', measuredRequests: 1, totalRequests: 1 },
    })
    expect(
      (await grader.grade({ type: 'token-budget', maxTokens: 15 }, { workspace, metrics })).passed,
    ).toBe(true)
    expect(
      (await grader.grade({ type: 'token-budget', maxTokens: 14 }, { workspace, metrics })).passed,
    ).toBe(false)
    expect(
      (
        await grader.grade(
          { type: 'token-budget', maxTokens: 100 },
          { workspace, metrics: { ...metrics, tokenUsage: undefined } },
        )
      ).passed,
    ).toBe(false)
  })
  it('评测任务将人格传入 Agent 并将最终回复传入 Grader', async () => {
    const contexts: Array<{ persona?: string }> = []
    const verifiedResponses: string[] = []
    const agent = {
      name: 'persona-agent',
      run: vi.fn(async (_task, context) => {
        contexts.push(context)
        return {
          status: 'submitted' as const,
          finalResponse: '请运行测试。',
          submission: { type: 'text' as const, content: '请运行测试。' },
          metrics: emptyMetrics({
            modelRequests: 1,
            inputTokens: 10,
            outputTokens: 5,
            tokenUsage: { status: 'complete', measuredRequests: 1, totalRequests: 1 },
          }),
        }
      }),
    } as AgentPort
    const benchmark = {
      name: 'native',
      load: async function* () {},
      prepare: async (evalCase, workspace) => ({
        evalCase,
        workspace,
        agentTask: { prompt: evalCase.task.prompt, taskSpec: evalCase.task.taskSpec },
      }),
      verify: async (_prepared, _submission, context) => {
        verifiedResponses.push(context.agentResult?.finalResponse ?? '')
        return { status: 'passed' as const, scores: {}, graderResults: [] }
      },
    } satisfies BenchmarkPort
    const workspace = fakeWorkspace()
    const runner = new TrialRunner({
      agent,
      benchmark,
      workspaceFactory: { create: async () => workspace } satisfies WorkspaceFactory,
      repository: new InMemoryEvalRepository(),
    })

    const result = await runner.run({ runId: 'run-persona', evalCase: evalCase() })

    expect(contexts[0]?.persona).toBe('简洁、直接')
    expect(verifiedResponses).toEqual(['请运行测试。'])
    expect(result.metrics.tokenUsage).toEqual({
      status: 'complete',
      measuredRequests: 1,
      totalRequests: 1,
    })
  })
})

function evalCase() {
  return parseEvalCase({
    schemaVersion: 1,
    id: 'persona-case',
    suite: 'regression',
    task: { prompt: '修复问题', taskSpec: { id: 'task', goal: '修复问题' } },
    persona: { instruction: '简洁、直接' },
    fixture: { path: 'fixture' },
    limits: { timeoutMs: 1_000, maxTurns: 2, maxToolCalls: 2 },
    submission: { type: 'text' },
    verification: { graders: [{ type: 'persona-rubric' }] },
  })
}

function fakeWorkspace(): WorkspacePort {
  return {
    root: process.cwd(),
    verificationCommandsAllowed: false,
    readFile: async () => '',
    writeFile: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }),
    changedPaths: async () => [],
    reset: async () => undefined,
    dispose: async () => undefined,
  }
}
