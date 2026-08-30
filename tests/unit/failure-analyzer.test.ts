import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../src/core/events/run-event.js'
import type { TrialResult } from '../../src/eval/domain/trial-result.js'
import { analyzeFailure } from '../../src/eval/analysis/failure-analyzer.js'

const baseTrial: TrialResult = {
  schemaVersion: 1,
  runId: 'run-1',
  trialId: 'trial-1',
  caseId: 'case-1',
  execution: { status: 'submitted' },
  submission: { status: 'valid' },
  verification: { status: 'failed' },
  infrastructure: { status: 'ok' },
  resolved: false,
  scores: {},
  metrics: {
    turns: 1,
    modelRequests: 1,
    toolCalls: 0,
    toolFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 1,
  },
  artifacts: [],
}

function event(source: RunEvent['source'], type: string, data: unknown, sequence = 1): RunEvent {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    trialId: 'trial-1',
    sequence,
    timestamp: new Date(0).toISOString(),
    source,
    type,
    data,
  }
}

describe('测试套件：评测失败分析', () => {
  it('验证：成功试验不产生失败归因', () => {
    const result = analyzeFailure({
      ...baseTrial,
      resolved: true,
      verification: { status: 'passed' },
    })
    expect(result).toEqual({
      category: 'none',
      message: 'Trial resolved successfully',
      identities: [],
      evidence: [],
    })
  })

  it('验证：基础设施失败优先于 Agent 和验证状态', () => {
    const result = analyzeFailure({ ...baseTrial, infrastructure: { status: 'setup_error' } }, [
      event('workspace', 'workspace.failed', { message: '无法创建工作区' }),
    ])
    expect(result.category).toBe('infrastructure')
    expect(result.evidence).toEqual(['无法创建工作区'])
  })

  it('验证：提取验证证据、失败测试身份和稳定指纹', () => {
    const result = analyzeFailure(baseTrial, [
      event('verifier', 'verification.failed', {
        callId: 'secret-like-id',
        message: '测试未通过',
        evidence: ['not ok 1 - should add value', 'duration_ms: 12'],
      }),
    ])
    expect(result.category).toBe('verification')
    expect(result.identities).toEqual(['should add value'])
    expect(result.fingerprint).toMatch(/^[a-f0-9]{16}$/u)
    expect(result.evidence).not.toContain('secret-like-id')
    expect(result.diagnosis?.evidenceRefs).toEqual([
      {
        runId: 'run-1',
        trialId: 'trial-1',
        sequence: 1,
        source: 'verifier',
        type: 'verification.failed',
      },
    ])
  })

  it('验证：没有可提取文本时仍保留可回溯事件引用', () => {
    const result = analyzeFailure(baseTrial, [
      event('verifier', 'verification.failed', { code: 'TEST_FAILED' }),
    ])
    expect(result.evidence).toEqual([])
    expect(result.diagnosis?.evidenceRefs).toEqual([
      {
        runId: 'run-1',
        trialId: 'trial-1',
        sequence: 1,
        source: 'verifier',
        type: 'verification.failed',
      },
    ])
  })

  it('验证：模型请求失败定位到模型生成阶段', () => {
    const result = analyzeFailure(
      { ...baseTrial, execution: { status: 'agent_error' }, verification: { status: 'passed' } },
      [event('model', 'model.failed', { error: 'provider unavailable', terminal: true })],
    )

    expect(result.diagnosis).toMatchObject({
      layer: 'model',
      stage: 'model_generation',
      confidence: 0.99,
    })
  })

  it('验证：多来源指令不被误判为语义冲突根因', () => {
    const result = analyzeFailure(
      { ...baseTrial, execution: { status: 'agent_error' }, verification: { status: 'passed' } },
      [event('agent', 'agent.instructions_loaded', { conflictCount: 2 })],
    )

    expect(result.diagnosis).toMatchObject({
      layer: 'agent',
      stage: 'unknown',
    })
  })

  it('验证：普通 Prompt 构建事件不会覆盖提交失败的默认定位', () => {
    const result = analyzeFailure(
      {
        ...baseTrial,
        submission: { status: 'missing' },
      },
      [event('agent', 'agent.prompt_composed', { messageCount: 4 })],
    )

    expect(result.diagnosis).toMatchObject({
      layer: 'agent',
      stage: 'submission',
    })
  })

  it('验证：多个直接失败事件按最后一个事件定位阻断点', () => {
    const result = analyzeFailure(
      { ...baseTrial, execution: { status: 'agent_error' }, verification: { status: 'passed' } },
      [
        event('model', 'model.failed', { error: '第一次请求失败' }, 2),
        event('tool', 'tool.failed', { error: '工具权限被拒绝', terminal: true }, 5),
      ],
    )

    expect(result.diagnosis).toMatchObject({
      layer: 'tool',
      stage: 'tool_execution',
    })
  })

  it('验证：恢复后的工具失败不能覆盖最终预算耗尽原因', () => {
    const result = analyzeFailure({ ...baseTrial, execution: { status: 'budget_exhausted' } }, [
      event('tool', 'tool.failed', { callId: 'a', error: '文件不存在' }, 1),
      event('tool', 'tool.completed', { callId: 'b', output: '找到文件' }, 2),
    ])
    expect(result.diagnosis?.layer).toBe('runtime')
  })

  it('验证：截断超长证据并限制条目数量', () => {
    const result = analyzeFailure(
      { ...baseTrial, execution: { status: 'agent_error' }, verification: { status: 'error' } },
      [event('verifier', 'verification.failed', { message: 'x'.repeat(10_000) })],
    )
    expect(result.category).toBe('verification')
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]?.length).toBe(4_001)
  })
})
