import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../src/core/clock.js'
import { LocalTraceRecorder } from '../../src/observability/local-trace-recorder.js'
import {
  buildMetadataUploadEnvelope,
  parseTraceUploadEnvelope,
} from '../../src/observability/trace-upload-envelope.js'
import { TraceOutbox } from '../../src/observability/trace-outbox.js'
import { TraceCaptureSink } from '../../src/observability/trace-capture-sink.js'
import { createSecurityServices } from '../../src/security/security-services.js'
import { ResolvedSecret } from '../../src/security/resolved-secret.js'

describe('测试套件：本地 Trace 与隐私上传门禁', () => {
  it('按顺序以私有权限保存脱敏后的本地事件', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-trace-'))
    try {
      const security = createSecurityServices({})
      security.registry.register(new ResolvedSecret('trace-secret-value'))
      const recorder = new LocalTraceRecorder({
        projectRoot: root,
        runId: 'run-1',
        trialId: 'trial-1',
        clock: new FakeClock(),
        redactor: security.redactor,
        guard: security.guard,
      })

      await recorder.emit('model', 'model.completed', { text: 'trace-secret-value' })
      await recorder.emit('tool', 'tool.completed', { ok: true })

      const events = await recorder.readAll()
      expect(events.map((event) => event.sequence)).toEqual([0, 1])
      expect(JSON.stringify(events)).not.toContain('trace-secret-value')
      expect((await stat(recorder.filePath)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('合并流式文本并仅记录后续请求新增的上下文', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-trace-'))
    try {
      const security = createSecurityServices({})
      const recorder = new LocalTraceRecorder({
        projectRoot: root,
        runId: 'run-incremental',
        trialId: 'trial-incremental',
        redactor: security.redactor,
        guard: security.guard,
      })
      const first = [{ role: 'user', content: 'first' }]
      const second = [...first, { role: 'assistant', content: 'second' }]

      await recorder.emit('model', 'model.requested', { turn: 1, messages: first, tools: [] })
      await recorder.emit('model', 'model.text_delta', { delta: 'hel' })
      await recorder.emit('model', 'model.text_delta', { delta: 'lo' })
      await recorder.emit('model', 'model.completed', { text: 'hello' })
      await recorder.emit('model', 'model.requested', { turn: 2, messages: second, tools: [] })

      const events = await recorder.readAll()
      expect(events.filter((event) => event.type === 'model.text_delta')).toHaveLength(1)
      expect(events.find((event) => event.type === 'model.text_delta')?.data).toEqual({
        delta: 'hello',
        chunkCount: 2,
        truncated: false,
      })
      expect(events.filter((event) => event.type === 'model.requested')[1]?.data).toMatchObject({
        messageCount: 2,
        messagesAdded: [{ role: 'assistant', content: 'second' }],
      })
      expect(
        events.filter((event) => event.type === 'model.requested')[1]?.data,
      ).not.toHaveProperty('messages')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('Trace 超过软上限时保留截断标记和 Agent 终态', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-trace-'))
    try {
      const security = createSecurityServices({})
      const recorder = new LocalTraceRecorder({
        projectRoot: root,
        runId: 'run-bounded',
        trialId: 'trial-bounded',
        redactor: security.redactor,
        guard: security.guard,
        maxTraceBytes: 2_000,
      })

      for (let index = 0; index < 20; index += 1) {
        await recorder.emit('tool', 'tool.completed', { output: 'x'.repeat(400), index })
      }
      await recorder.emit('agent', 'agent.completed', { status: 'submitted' })

      const events = await recorder.readAll()
      expect(events.some((event) => event.type === 'trace.truncated')).toBe(true)
      expect(events.at(-1)?.type).toBe('agent.completed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('未授权时拒绝构建上传信封，授权后只包含允许的元数据', async () => {
    const events = [
      {
        schemaVersion: 1 as const,
        runId: 'run-1',
        trialId: 'trial-1',
        sequence: 0,
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'model' as const,
        type: 'model.completed',
        data: { privateCode: 'const secret = 1' },
      },
    ]

    expect(() => buildMetadataUploadEnvelope(events, { granted: false })).toThrow(
      'Trace upload consent is required',
    )
    const envelope = buildMetadataUploadEnvelope(events, {
      granted: true,
      consentId: 'consent-1',
    })

    expect(envelope.eventCounts).toEqual({ 'model:model.completed': 1 })
    expect(envelope.runIdHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(envelope)).not.toContain('run-1')
    expect(JSON.stringify(envelope)).not.toContain('privateCode')
    expect(JSON.stringify(envelope)).not.toContain('const secret')
    expect(parseTraceUploadEnvelope(envelope)).toEqual(envelope)
  })

  it('未知事件名不会被当作可上传字段', () => {
    const envelope = buildMetadataUploadEnvelope(
      [
        {
          schemaVersion: 1,
          runId: 'run',
          trialId: 'trial',
          sequence: 0,
          timestamp: '2026-01-01T00:00:00.000Z',
          source: 'model',
          type: 'private-user-content',
          data: {},
        },
      ],
      { granted: true, consentId: 'consent' },
    )

    expect(envelope.eventCounts).toEqual({ 'model:other': 1 })
    expect(JSON.stringify(envelope)).not.toContain('private-user-content')
  })

  it('拒绝通过符号链接将 Trace 写到项目之外', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-trace-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'codeden-trace-outside-'))
    try {
      await mkdir(path.join(root, '.codeden'), { recursive: true })
      await symlink(outside, path.join(root, '.codeden', 'traces'))
      const security = createSecurityServices({})
      const recorder = new LocalTraceRecorder({
        projectRoot: root,
        runId: 'run-safe',
        trialId: 'trial-safe',
        redactor: security.redactor,
        guard: security.guard,
      })

      await expect(recorder.emit('agent', 'agent.started', {})).rejects.toMatchObject({
        code: 'WORKSPACE_PATH_DENIED',
      })
      await expect(readFile(path.join(outside, 'run-safe.jsonl'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('可靠队列按退避时间重试并在确认送达后移除记录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-outbox-'))
    try {
      const clock = new FakeClock()
      const outbox = new TraceOutbox(root, clock)
      const envelope = buildMetadataUploadEnvelope([], {
        granted: true,
        consentId: 'consent-1',
        runId: 'run-1',
        trialId: 'trial-1',
      })

      const record = await outbox.enqueue(envelope)
      expect(await outbox.listReady()).toHaveLength(1)
      await outbox.markFailed(record.id, 'network unavailable')
      expect(await outbox.listReady()).toHaveLength(0)
      clock.advance(2_000)
      expect(await outbox.listReady()).toHaveLength(1)
      await outbox.markDelivered(record.id)
      expect(await outbox.listReady()).toHaveLength(0)
      expect(() => outbox.filePath('../outside')).toThrow('Outbox id must be a UUID')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('Agent 进入终态后按授权自动封箱并加入上传队列', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-capture-'))
    try {
      const security = createSecurityServices({})
      const outbox = new TraceOutbox(root, new FakeClock())
      const sink = new TraceCaptureSink({
        recorder: new LocalTraceRecorder({
          projectRoot: root,
          runId: 'run-capture',
          trialId: 'trial-capture',
          redactor: security.redactor,
          guard: security.guard,
        }),
        outbox,
        consent: { granted: true, consentId: 'consent-capture' },
      })

      await sink.emit('agent', 'agent.started', {})
      await sink.emit('agent', 'agent.completed', { status: 'submitted' })

      expect(await outbox.listReady()).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ eventCount: 2 }) }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('并发更新同一待上传记录时不丢失重试次数', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-outbox-'))
    try {
      const clock = new FakeClock()
      const outbox = new TraceOutbox(root, clock)
      const record = await outbox.enqueue(
        buildMetadataUploadEnvelope([], {
          granted: true,
          consentId: 'consent-1',
          runId: 'run-2',
          trialId: 'trial-2',
        }),
      )

      await Promise.all([
        outbox.markFailed(record.id, 'first'),
        outbox.markFailed(record.id, 'second'),
      ])
      clock.advance(4_000)

      expect(await outbox.listReady()).toEqual([
        expect.objectContaining({ id: record.id, attemptCount: 2 }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('损坏的队列文件不阻塞其他待上传记录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-outbox-'))
    try {
      const outbox = new TraceOutbox(root, new FakeClock())
      const record = await outbox.enqueue(
        buildMetadataUploadEnvelope([], {
          granted: true,
          consentId: 'consent',
          runId: 'healthy',
          trialId: 'healthy',
        }),
      )
      const corruptId = '00000000-0000-4000-8000-000000000000'
      await writeFile(
        path.join(root, '.codeden', 'telemetry', 'outbox', `${corruptId}.json`),
        '{broken',
      )

      expect(await outbox.listReady()).toEqual([expect.objectContaining({ id: record.id })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
