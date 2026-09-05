import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SecretRedactor } from '../../packages/core/src/security/secret-redactor.js'
import { InMemorySecretRegistry } from '../../packages/core/src/security/secret-registry.js'
import { ResolvedSecret } from '../../packages/core/src/security/resolved-secret.js'
import {
  CorruptedFoldProjectionError,
  FoldedSessionMemorySchema,
} from '../../packages/agent-runtime/src/context/folding/folded-memory.js'
import { FoldProjectionStore } from '../../packages/agent-runtime/src/context/folding/fold-projection-store.js'
import {
  SessionFolder,
  UNRESOLVED_TOOL_CALL_MARKER,
  validateFold,
  type SessionTurnInput,
} from '../../packages/agent-runtime/src/context/folding/session-folder.js'
import { buildTranscript } from '../../packages/agent-runtime/src/context/folding/transcript-builder.js'
import type { ModelMessage } from '../../packages/agent-runtime/src/models/model-types.js'

function redactor(): SecretRedactor {
  const registry = new InMemorySecretRegistry()
  registry.register(new ResolvedSecret('sk-test-token-123'))
  return new SecretRedactor(registry)
}

function toolMessage(callId: string, content: string): ModelMessage {
  return { role: 'tool', content, toolCallId: callId }
}

function assistantToolCalls(calls: Array<{ id: string; name: string }>): ModelMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: calls.map((call) => ({ ...call, arguments: {} })),
  }
}

function turn(overrides: Partial<SessionTurnInput> = {}): SessionTurnInput {
  return {
    turnId: 'session-1:1',
    prompt: '修复 package.json 的版本号',
    status: 'verified_complete',
    finalResponse: '已完成',
    turnTranscript: [{ role: 'assistant', content: '已完成' }],
    ...overrides,
  }
}

describe('测试套件：TranscriptBuilder', () => {
  it('验证：脱敏 prompt、正文与工具调用参数', () => {
    const transcript = buildTranscript(
      [
        turn({
          turnTranscript: [
            assistantToolCalls([{ id: 'call_1', name: 'run_command' }]),
            toolMessage('call_1', '{"output":"ok"}'),
            { role: 'assistant', content: 'token 是 sk-test-token-123' },
          ],
        }),
      ],
      redactor(),
    )
    expect(transcript.turns[0]?.prompt).not.toContain('sk-test-token-123')
    const withSecret = transcript.turns[0]?.messages.at(-1)?.content ?? ''
    expect(withSecret).not.toContain('sk-test-token-123')
  })

  it('验证：同一区间重复冻结得到相同 digest，区间变化 digest 变化', () => {
    const turns = [turn(), turn({ turnId: 'session-1:2', prompt: '继续' })]
    expect(buildTranscript(turns).digest).toBe(buildTranscript(turns).digest)
    expect(buildTranscript(turns).digest).not.toBe(buildTranscript([turn()]).digest)
  })

  it('验证：未匹配 tool 结果的调用记为未完成（EX-13）', () => {
    const transcript = buildTranscript([
      turn({
        status: 'timeout',
        stopReason: 'timeout',
        turnTranscript: [assistantToolCalls([{ id: 'call_9', name: 'run_command' }])],
      }),
    ])
    expect(transcript.unresolvedToolCalls).toHaveLength(1)
    expect(transcript.unresolvedToolCalls[0]?.toolName).toBe('run_command')
    expect(transcript.failedTurnIds).toHaveLength(1)
  })
})

describe('测试套件：SessionFolder 确定性折叠', () => {
  const folder = new SessionFolder()

  it('验证：确定性抽取三层记忆并保留首末 prompt 与失败证据', () => {
    const turns: SessionTurnInput[] = [
      turn({ turnId: 'session-1:1' }),
      turn({
        turnId: 'session-1:2',
        prompt: '跑测试并修复失败用例',
        status: 'agent_error',
        finalResponse: '',
        turnTranscript: [
          assistantToolCalls([{ id: 'call_1', name: 'run_command' }]),
          toolMessage(
            'call_1',
            '{"code":"TOOL_EXECUTION_FAILED","category":"tool","message":"npm test 失败","retryable":false}',
          ),
        ],
      }),
    ]
    const result = folder.fold({
      sessionId: 'session-1',
      trigger: 'auto',
      turns,
      sourceSequenceRange: { from: 1, to: 2 },
    })
    expect(result.projection.degraded).toBe(true)
    expect(result.memory.episodeMemory.taskDescription).toBe('修复 package.json 的版本号')
    expect(result.memory.workingMemory.immediateGoal).toBe('跑测试并修复失败用例')
    expect(result.memory.toolMemory.toolsUsed[0]).toMatchObject({
      tool: 'run_command',
      calls: 1,
      failures: 1,
    })
    expect(result.memory.workingMemory.currentChallenges.join('\n')).toContain('npm test 失败')
    expect(result.memory.sourceDigest).toBe(result.transcript.digest)
    expect(FoldedSessionMemorySchema.safeParse(result.memory).success).toBe(true)
  })

  it('验证：未完成 tool call 按未知保留而非摘要为成功（EX-13）', () => {
    const result = folder.fold({
      sessionId: 'session-1',
      trigger: 'tool',
      turns: [
        turn({
          status: 'timeout',
          stopReason: 'timeout',
          turnTranscript: [assistantToolCalls([{ id: 'call_9', name: 'run_command' }])],
        }),
      ],
      sourceSequenceRange: { from: 1, to: 1 },
    })
    const challenges = result.memory.workingMemory.currentChallenges.join('\n')
    expect(challenges).toContain(UNRESOLVED_TOOL_CALL_MARKER)
    expect(result.memory.workingMemory.nextActions[0]?.relatedTool).toBe('run_command')
    // 未完成调用不计入失败次数，也不允许消失。
    expect(result.memory.toolMemory.toolsUsed[0]).toMatchObject({ calls: 1, failures: 0 })
  })

  it('验证：空区间拒绝折叠', () => {
    expect(() =>
      folder.fold({
        sessionId: 'session-1',
        trigger: 'manual',
        turns: [],
        sourceSequenceRange: { from: 0, to: 0 },
      }),
    ).toThrow('折叠区间为空')
  })
})

describe('测试套件：FoldValidator', () => {
  it('验证：必留项缺失时拒绝切换', () => {
    const folder = new SessionFolder()
    const turns: SessionTurnInput[] = [
      turn(),
      turn({
        turnId: 'session-1:2',
        prompt: '第二个目标',
        status: 'agent_error',
        turnTranscript: [
          assistantToolCalls([{ id: 'call_1', name: 'edit_file' }]),
          toolMessage(
            'call_1',
            '{"code":"TOOL_EXECUTION_FAILED","category":"tool","message":"boom","retryable":false}',
          ),
        ],
      }),
    ]
    const result = folder.fold({
      sessionId: 'session-1',
      trigger: 'auto',
      turns,
      sourceSequenceRange: { from: 1, to: 2 },
    })
    const valid = validateFold(result.memory, {
      firstPrompt: turns[0]?.prompt ?? '',
      lastPrompt: turns.at(-1)?.prompt ?? '',
      failedToolResultCount: 1,
      unresolvedToolCallCount: 0,
    })
    expect(valid.ok).toBe(true)

    expect(
      validateFold(result.memory, {
        firstPrompt: '被篡改的目标',
        lastPrompt: turns.at(-1)?.prompt ?? '',
        failedToolResultCount: 1,
        unresolvedToolCallCount: 0,
      }).missing,
    ).toContain('任务描述未保留首条 prompt')

    expect(
      validateFold(result.memory, {
        firstPrompt: turns[0]?.prompt ?? '',
        lastPrompt: turns.at(-1)?.prompt ?? '',
        failedToolResultCount: 3,
        unresolvedToolCallCount: 0,
      }).missing.some((item) => item.includes('失败证据不完整')),
    ).toBe(true)

    expect(
      validateFold(result.memory, {
        firstPrompt: turns[0]?.prompt ?? '',
        lastPrompt: turns.at(-1)?.prompt ?? '',
        failedToolResultCount: 0,
        unresolvedToolCallCount: 2,
      }).missing.some((item) => item.includes('EX-13')),
    ).toBe(true)
  })
})

describe('测试套件：FoldProjectionStore', () => {
  it('验证：投影原子落盘并可回读，原始事件不受影响', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-fold-'))
    try {
      const sessionsDir = path.join(root, '.codeden', 'sessions', 'session-1')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(sessionsDir, { recursive: true })
      await writeFile(
        path.join(sessionsDir, 'updates.jsonl'),
        '{"schemaVersion":1,"sequence":1}\n',
        { mode: 0o600 },
      )
      const store = new FoldProjectionStore(root)
      const folder = new SessionFolder()
      const { projection } = folder.fold({
        sessionId: 'session-1',
        trigger: 'manual',
        turns: [turn()],
        sourceSequenceRange: { from: 1, to: 1 },
        now: () => new Date('2026-09-05T00:00:00.000Z'),
      })
      await store.save('session-1', projection)
      const loaded = await store.load('session-1')
      expect(loaded?.memory.sourceDigest).toBe(projection.memory.sourceDigest)
      expect(loaded?.degraded).toBe(true)
      // 原始事件文件保持原样。
      const updates = await readFile(path.join(sessionsDir, 'updates.jsonl'), 'utf8')
      expect(updates).toBe('{"schemaVersion":1,"sequence":1}\n')
      await store.clear('session-1')
      expect(await store.load('session-1')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：损坏的投影抛出 CorruptedFoldProjectionError 而不是静默回退', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-fold-'))
    try {
      const store = new FoldProjectionStore(root)
      const sessionsDir = path.join(root, '.codeden', 'sessions', 'session-1')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(sessionsDir, { recursive: true })
      await writeFile(path.join(sessionsDir, 'fold-projection.json'), '{ broken', {
        mode: 0o600,
      })
      await expect(store.load('session-1')).rejects.toBeInstanceOf(CorruptedFoldProjectionError)
      await writeFile(
        path.join(sessionsDir, 'fold-projection.json'),
        JSON.stringify({ schemaVersion: 1, hello: 1 }),
        { mode: 0o600 },
      )
      await expect(store.load('session-1')).rejects.toBeInstanceOf(CorruptedFoldProjectionError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：非法 session id 与不存在的会话安全处理', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-fold-'))
    try {
      const store = new FoldProjectionStore(root)
      expect(await store.load('missing-session')).toBeUndefined()
      await expect(
        store.save('../escape', {
          schemaVersion: 1,
          createdAt: '2026-09-05T00:00:00.000Z',
          degraded: true,
          memory: {
            schemaVersion: 1,
            sessionId: 'escape',
            createdAt: '2026-09-05T00:00:00.000Z',
            trigger: 'manual',
            sourceSequenceRange: { from: 1, to: 1 },
            episodeMemory: { taskDescription: 'x', keyEvents: [], currentProgress: '' },
            workingMemory: { immediateGoal: 'x', currentChallenges: [], nextActions: [] },
            toolMemory: { toolsUsed: [], derivedRules: [] },
            sourceDigest: 'digest',
          },
        }),
      ).rejects.toThrow('Session id')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
