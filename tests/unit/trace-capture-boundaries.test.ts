import { mkdtemp, readFile, rm, utimes, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalTraceRecorder } from '../../packages/telemetry/src/local-trace-recorder.js'
import { TraceCaptureSink } from '../../packages/telemetry/src/trace-capture-sink.js'
import { TraceOutbox } from '../../packages/telemetry/src/trace-outbox.js'
import {
  createTraceCaptureSink,
  pruneLocalTraces,
} from '../../packages/telemetry/src/trace-capture-factory.js'
import { recoverTraceOutbox } from '../../packages/telemetry/src/trace-outbox-recovery.js'
import { createSecurityServices } from '../../packages/core/src/security/security-services.js'
import { emptyMetrics } from '../../packages/core/src/metrics.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function restart(root: string, consentId = 'consent', enabled = true) {
  return createTraceCaptureSink({
    projectRoot: root,
    runId: 'next-run',
    trialId: 'next-trial',
    security: createSecurityServices({}),
    telemetry: { enabled, consentId, traceRetentionDays: 30, maxTraceFiles: 500 },
  })
}
async function setup(maxTraceBytes?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-trace-edge-'))
  roots.push(root)
  const security = createSecurityServices({})
  const recorder = new LocalTraceRecorder({
    projectRoot: root,
    runId: 'run',
    trialId: 'trial',
    maxTraceBytes,
    redactor: security.redactor,
    guard: security.guard,
  })
  return { root, recorder }
}

describe('测试套件：Trace 采集异常边界', () => {
  it('重复运行编号不能覆盖或拼接已存在的 Trace', async () => {
    const { root, recorder } = await setup()
    await recorder.emit('agent', 'agent.started')
    const security = createSecurityServices({})
    const duplicate = new LocalTraceRecorder({
      projectRoot: root,
      runId: 'run',
      trialId: 'trial',
      redactor: security.redactor,
      guard: security.guard,
    })
    await expect(duplicate.emit('agent', 'agent.started')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await recorder.readAll()).toHaveLength(1)
  })
  it('同长度提示词改写和工具定义变化会保存新的完整快照', async () => {
    const { recorder } = await setup()
    await recorder.emit('model', 'model.requested', {
      messages: [{ content: 'old' }],
      tools: [{ name: 'a' }],
    })
    await recorder.emit('model', 'model.requested', {
      messages: [{ content: 'new' }],
      tools: [{ name: 'b' }],
    })
    expect((await recorder.readAll())[1]?.data).toMatchObject({
      messages: [{ content: 'new' }],
      tools: [{ name: 'b' }],
    })
  })

  it('并发事件保持调用顺序，子 Agent 的增量文本不与父任务混合', async () => {
    const { recorder } = await setup()
    await Promise.all([
      recorder.emit('model', 'model.text_delta', {
        delta: '父',
        agentSpanId: 'parent',
        agentDepth: 0,
      }),
      recorder.emit('model', 'model.text_delta', {
        delta: '子',
        agentSpanId: 'child',
        agentDepth: 1,
      }),
      recorder.emit('model', 'model.completed', {
        text: '子',
        agentSpanId: 'child',
        agentDepth: 1,
      }),
    ])
    const events = await recorder.readAll()
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2])
    expect(events[0]?.data).toMatchObject({ delta: '父', agentSpanId: 'parent' })
    expect(events[1]?.data).toMatchObject({ delta: '子', agentSpanId: 'child' })
  })

  it('大量验证事件不能挤掉根任务终态', async () => {
    const { recorder } = await setup(4000)
    for (let index = 0; index < 40; index++) {
      await recorder.emit('verifier', 'verification.failed', { evidence: 'x'.repeat(800) })
    }
    await recorder.emit('agent', 'agent.completed', {
      status: 'submitted',
      metrics: emptyMetrics(),
    })
    expect((await recorder.readAll()).at(-1)?.type).toBe('agent.completed')
  })

  it('容量耗尽且错误消息很长时仍保留有界终态和计量', async () => {
    const { recorder } = await setup(4000)
    for (let i = 0; i < 20; i++) {
      await recorder.emit('tool', 'tool.completed', { output: 'x'.repeat(700) })
    }
    await recorder.emit('agent', 'agent.completed', {
      status: 'agent_error',
      stopReason: '错误'.repeat(6000),
      metrics: emptyMetrics(),
    })
    const terminal = (await recorder.readAll()).at(-1)
    expect(terminal).toMatchObject({
      type: 'agent.completed',
      data: { status: 'agent_error', metrics: emptyMetrics(), truncated: true },
    })
    expect(Buffer.byteLength(await readFile(recorder.filePath, 'utf8'))).toBeLessThanOrEqual(4000)
  })

  it('终态超过单事件限制也保留状态、计量和父子身份', async () => {
    const { recorder } = await setup()
    await recorder.emit('agent', 'agent.completed', {
      agentDepth: 0,
      agentSpanId: 'root-span',
      status: 'agent_error',
      stopReason: '错误'.repeat(200_000),
      metrics: emptyMetrics(),
    })
    expect((await recorder.readAll()).at(-1)).toMatchObject({
      type: 'agent.completed',
      data: {
        agentDepth: 0,
        agentSpanId: 'root-span',
        status: 'agent_error',
        metrics: emptyMetrics(),
        truncated: true,
      },
    })
    await recorder.emit('agent', 'agent.completed', { status: 'submitted' })
    await recorder.emit('model', 'model.text_delta', { delta: '迟到的文本' })
    expect(await recorder.readAll()).toHaveLength(1)
  })

  it('子 Agent 终态不封箱，根任务封箱只保存数值和指纹', async () => {
    const { root, recorder } = await setup()
    const outbox = new TraceOutbox(root)
    const sink = new TraceCaptureSink({
      recorder,
      outbox,
      consent: { granted: true, consentId: 'consent' },
    })
    await sink.emit('agent', 'agent.prompt_composed', {
      hasPersona: true,
      personaDigest: 'a'.repeat(64),
      promptDigest: 'b'.repeat(64),
      prompt: '用户隐私正文',
    })
    await sink.emit('agent', 'agent.completed', { agentDepth: 1, status: 'submitted' })
    expect(await outbox.listReady()).toHaveLength(0)
    await sink.emit('agent', 'agent.completed', {
      agentDepth: 0,
      metrics: emptyMetrics({
        modelRequests: 1,
        inputTokens: 4,
        outputTokens: 3,
        tokenUsage: { status: 'complete', measuredRequests: 1, totalRequests: 1 },
      }),
    })
    const records = await outbox.listReady()
    expect(records[0]?.payload).toMatchObject({
      tokens: { input: 4, output: 3, requests: 1, status: 'complete' },
      prompt: { hasRuntimePersona: true },
      trace: { completed: true, truncated: false },
    })
    expect(JSON.stringify(records)).not.toContain('用户隐私正文')
  })

  it('只发一次终态后入队失败，下次启动会补偿且送达后不重复入队', async () => {
    const { root, recorder } = await setup()
    const outbox = new TraceOutbox(root)
    vi.spyOn(outbox, 'enqueue').mockRejectedValueOnce(new Error('disk full'))
    const sink = new TraceCaptureSink({
      recorder,
      outbox,
      consent: { granted: true, consentId: 'consent' },
    })
    await expect(sink.emit('agent', 'agent.completed')).rejects.toThrow('disk full')
    await restart(root)
    const records = await outbox.listReady()
    expect(records).toHaveLength(1)
    expect(
      (await recorder.readAll()).filter((event) => event.type === 'agent.completed'),
    ).toHaveLength(1)
    await restart(root)
    expect(await outbox.listReady()).toHaveLength(1)
    await outbox.markDelivered(records[0]!.id)
    await outbox.markDelivered(records[0]!.id)
    await restart(root)
    expect(await outbox.listReady()).toHaveLength(0)
    expect(await outbox.contains(records[0]!.payload.traceId)).toBe(true)
  })

  it('授权关闭或变更时不补传，原本未授权的历史记录也不补传', async () => {
    const { root, recorder } = await setup()
    const outbox = new TraceOutbox(root)
    vi.spyOn(outbox, 'enqueue').mockRejectedValueOnce(new Error('disk full'))
    const sink = new TraceCaptureSink({
      recorder,
      outbox,
      consent: { granted: true, consentId: 'consent' },
    })
    await expect(sink.emit('agent', 'agent.completed')).rejects.toThrow()
    await restart(root, 'consent', false)
    await restart(root, 'different-consent')
    expect(await outbox.listReady()).toHaveLength(0)
    const second = await setup()
    await second.recorder.emit('agent', 'agent.completed')
    await restart(second.root)
    expect(await new TraceOutbox(second.root).listReady()).toHaveLength(0)
  })

  it('损坏文件和符号链接不妨碍补偿健康记录，待补偿记录不会被保留策略删除', async () => {
    const { root, recorder } = await setup(4000)
    const outbox = new TraceOutbox(root)
    vi.spyOn(outbox, 'enqueue').mockRejectedValueOnce(new Error('disk full'))
    const sink = new TraceCaptureSink({
      recorder,
      outbox,
      consent: { granted: true, consentId: 'consent' },
    })
    await sink.emit('agent', 'agent.started')
    await expect(
      sink.emit('agent', 'agent.completed', {
        stopReason: '错误'.repeat(6000),
        metrics: emptyMetrics(),
      }),
    ).rejects.toThrow('disk full')
    const directory = path.dirname(recorder.filePath)
    await writeFile(path.join(directory, 'broken.jsonl'), '{broken}\n')
    await symlink(recorder.filePath, path.join(directory, 'linked.jsonl'))
    const old = new Date(Date.now() - 60 * 24 * 60 * 60_000)
    await utimes(recorder.filePath, old, old)
    await pruneLocalTraces(root, {
      traceRetentionDays: 30,
      maxTraceFiles: 1,
      enabled: true,
      consentId: 'consent',
    })
    expect(await readFile(recorder.filePath, 'utf8')).toContain('agent.completed')
    await restart(root)
    expect(await outbox.listReady()).toHaveLength(1)
    expect((await outbox.listReady())[0]?.payload.tokens).toBeDefined()
  })

  it('并发补偿保持幂等且不覆盖失败重试次数', async () => {
    const { root, recorder } = await setup()
    const outbox = new TraceOutbox(root)
    vi.spyOn(outbox, 'enqueue').mockRejectedValueOnce(new Error('disk full'))
    await expect(
      new TraceCaptureSink({
        recorder,
        outbox,
        consent: { granted: true, consentId: 'consent' },
      }).emit('agent', 'agent.completed'),
    ).rejects.toThrow()
    await Promise.all([restart(root), restart(root)])
    const record = (await outbox.listReady())[0]!
    expect(await outbox.listReady()).toHaveLength(1)
    await outbox.markFailed(record.id, '临时错误')
    await restart(root)
    const saved = JSON.parse(await readFile(outbox.filePath(record.id), 'utf8'))
    expect(saved.attemptCount).toBe(1)
    expect(await outbox.listReady()).toHaveLength(0)
  })

  it('补偿分批推进，一条入队失败不会阻断其他记录', async () => {
    const { root } = await setup()
    const security = createSecurityServices({})
    const outbox = new TraceOutbox(root)
    const failure = vi.spyOn(outbox, 'enqueue').mockRejectedValue(new Error('disk full'))
    for (const id of ['a', 'b', 'c']) {
      const recorder = new LocalTraceRecorder({
        projectRoot: root,
        runId: id,
        trialId: id,
        redactor: security.redactor,
        guard: security.guard,
      })
      await expect(
        new TraceCaptureSink({
          recorder,
          outbox,
          consent: { granted: true, consentId: 'consent' },
        }).emit('agent', 'agent.completed'),
      ).rejects.toThrow()
    }
    failure.mockRestore()
    vi.spyOn(outbox, 'enqueue').mockRejectedValueOnce(new Error('一条失败'))
    await recoverTraceOutbox(root, outbox, 'consent', 2)
    expect(await outbox.listReady()).toHaveLength(1)
    await recoverTraceOutbox(root, outbox, 'consent', 2)
    expect(await outbox.listReady()).toHaveLength(3)
  })

  it('保留策略只清理过期且已结束的 Trace，不删除运行中记录', async () => {
    const { root, recorder } = await setup()
    await recorder.emit('agent', 'agent.completed')
    const active = path.join(root, '.codeden', 'traces', 'active.jsonl')
    await writeFile(active, '{"type":"agent.started"}\n')
    const old = new Date(Date.now() - 60 * 24 * 60 * 60_000)
    await utimes(recorder.filePath, old, old)
    await utimes(active, old, old)
    await pruneLocalTraces(root, { traceRetentionDays: 30, maxTraceFiles: 500 })
    await expect(readFile(recorder.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(active, 'utf8')).toContain('agent.started')
  })
})
