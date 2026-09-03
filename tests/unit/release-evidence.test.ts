import { describe, expect, it } from 'vitest'
import {
  buildReleaseEvidenceFromRuns,
  loadReleaseEvidence,
} from '../../packages/eval-engine/src/optimization/release-evidence-builder.js'
import { InMemoryEvalRepository } from '../../packages/eval-engine/src/adapters/repositories/in-memory-eval.repository.js'
import type { EvalRun } from '../../packages/eval-engine/src/domain/eval-run.js'
import type { TrialResult } from '../../packages/eval-engine/src/domain/trial-result.js'
import { emptyMetrics } from '../../packages/core/src/metrics.js'
import { evidenceCaseDigests } from '../../packages/eval-engine/src/optimization/evidence-case-digests.js'
import { createRunEvidence } from '../../packages/eval-engine/src/optimization/run-evidence.js'
import { loadDemoCase } from '../helpers/eval-harness.js'
import {
  MockModelProvider,
  toolCall,
} from '../../packages/agent-runtime/src/models/mock-model-provider.js'
import { EvalRunner } from '../../packages/eval-engine/src/application/eval-runner.js'
import { createCodeDenAgent } from '../../packages/agent-runtime/src/create-codeden-runtime.js'
import { NativeBenchmarkAdapter } from '../../packages/eval-engine/src/adapters/benchmarks/native/native-benchmark.adapter.js'
import { TemporaryWorkspaceFactory } from '../../packages/agent-runtime/src/workspace/temporary-workspace.js'

function sample() {
  const run: EvalRun = {
    schemaVersion: 1,
    runId: 'run',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'completed',
    caseIds: ['case'],
    agentName: 'test',
    evidence: {
      agentDigest: 'a'.repeat(64),
      environmentDigest: 'b'.repeat(64),
      datasetDigest: 'c'.repeat(64),
      graderDigest: 'd'.repeat(64),
      cases: [
        { id: 'case', suite: 'regression', digest: 'e'.repeat(64), graderDigest: 'f'.repeat(64) },
      ],
    },
  }
  Object.assign(run.evidence!, evidenceCaseDigests(run.evidence!.cases))
  const trial: TrialResult = {
    schemaVersion: 1,
    runId: 'run',
    trialId: 'trial',
    caseId: 'case',
    execution: { status: 'submitted' },
    submission: { status: 'valid' },
    verification: { status: 'passed' },
    infrastructure: { status: 'ok' },
    resolved: true,
    scores: {},
    artifacts: [],
    metrics: emptyMetrics({
      modelRequests: 1,
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 100,
      tokenUsage: { status: 'complete', measuredRequests: 1, totalRequests: 1 },
    }),
  }
  return { run, trials: [trial] }
}

describe('测试套件：从已落盘试验构建发布证据', () => {
  it('实际执行预算耗尽但文件校验通过时可直接构建发布证据', async () => {
    const value = await loadDemoCase()
    value.limits.maxTurns = 1
    const model = new MockModelProvider([
      toolCall('write_file', {
        path: 'package.json',
        content: JSON.stringify({
          name: 'basic-node-project',
          version: '2.0.0',
          private: true,
          description: 'CodeDen native eval fixture',
        }),
      }),
    ])
    const repository = new InMemoryEvalRepository()
    const summary = await new EvalRunner({
      agent: createCodeDenAgent(model),
      repository,
      benchmark: new NativeBenchmarkAdapter(),
      workspaceFactory: new TemporaryWorkspaceFactory(),
      evidence: await createRunEvidence([value], model),
    }).run([value])
    expect(summary.trials[0]).toMatchObject({
      resolved: true,
      execution: { status: 'budget_exhausted' },
    })
    const evidence = await loadReleaseEvidence(repository, [summary.runId], 'v1')
    expect(evidence.suites[0]?.passed).toBe(1)
  })

  it('执行时清单在样本逆序或拆分后保持相同摘要，人格配置变化则改变摘要', async () => {
    const a = await loadDemoCase(),
      b = { ...a, id: 'second' }
    const model = new MockModelProvider([])
    const forward = await createRunEvidence([a, b], model)
    const reverse = await createRunEvidence([b, a], model)
    const split = evidenceCaseDigests([
      ...(await createRunEvidence([a], model)).cases,
      ...(await createRunEvidence([b], model)).cases,
    ])
    expect(reverse.datasetDigest).toBe(forward.datasetDigest)
    expect(reverse.graderDigest).toBe(forward.graderDigest)
    expect(split).toEqual({
      datasetDigest: forward.datasetDigest,
      graderDigest: forward.graderDigest,
    })
    const changed = await createRunEvidence(
      [{ ...a, persona: { instruction: '简洁回答', source: 'test' } }, b],
      model,
    )
    expect(changed.datasetDigest).not.toBe(forward.datasetDigest)
  })
  it('相同样本逆序或拆成不同批次时发布摘要一致', () => {
    const a = sample(),
      b = sample()
    b.run.runId = 'run-b'
    b.run.caseIds = ['case-b']
    b.run.evidence!.cases[0]!.id = 'case-b'
    Object.assign(b.run.evidence!, evidenceCaseDigests(b.run.evidence!.cases))
    Object.assign(b.trials[0]!, { runId: 'run-b', trialId: 'trial-b', caseId: 'case-b' })
    const together = structuredClone(a)
    together.run.caseIds.push('case-b')
    together.run.evidence!.cases.push(...b.run.evidence!.cases)
    Object.assign(together.run.evidence!, evidenceCaseDigests(together.run.evidence!.cases))
    together.trials.push({ ...b.trials[0]!, runId: 'run' })
    const build = (runs: (typeof a)[]) => buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs })
    const expected = build([together])
    together.run.evidence!.cases.reverse()
    together.run.caseIds.reverse()
    together.trials.reverse()
    for (const actual of [build([a, b]), build([b, a]), build([together])]) {
      expect(actual.datasetDigest).toBe(expected.datasetDigest)
      expect(actual.graderDigest).toBe(expected.graderDigest)
      expect(actual.suites).toEqual(expected.suites)
    }
  })

  it('旧清单和被篡改的样本摘要禁止用于发布', () => {
    const value = sample()
    value.run.evidence!.cases[0]!.graderDigest = undefined
    expect(() => buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs: [value] })).toThrow(
      '重新运行评测',
    )
    value.run.evidence!.cases[0]!.graderDigest = 'a'.repeat(64)
    expect(() => buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs: [value] })).toThrow(
      '摘要',
    )
  })

  it('未知请求总量不能报告完整覆盖率', () => {
    const value = sample()
    value.trials[0]!.metrics.tokenUsage = {
      status: 'partial',
      measuredRequests: 1,
      totalRequests: 1,
      collectionComplete: false,
    }
    expect(
      buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs: [value] }).tokenUsageCoverage,
    ).toBe(0)
  })
  it('预算耗尽但独立验证通过的合法结果仍能构建发布证据', () => {
    const value = sample()
    value.trials[0]!.execution.status = 'budget_exhausted'
    expect(
      buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs: [value] }).suites[0]?.passed,
    ).toBe(1)
  })
  it('使用全部试验重算 P95，不取各批次的最大延迟', () => {
    const value = sample()
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `case-${index}`,
      suite: 'regression' as const,
      digest: 'e'.repeat(64),
      graderDigest: 'f'.repeat(64),
    }))
    value.run.caseIds = entries.map((item) => item.id)
    value.run.evidence!.cases = entries
    Object.assign(value.run.evidence!, evidenceCaseDigests(entries))
    const original = value.trials[0]!
    value.trials = entries.map((item, index) => ({
      ...original,
      trialId: `trial-${index}`,
      caseId: item.id,
      metrics: { ...original.metrics, durationMs: index === 19 ? 10000 : 1 },
    }))
    const result = buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs: [value] })
    expect(result.p95LatencyMs).toBe(1)
    expect(result.totalTokens).toBe(300)
  })
  it('从仓库原始试验重算通过数、消耗和延迟', async () => {
    const value = sample(),
      repository = new InMemoryEvalRepository()
    await repository.createRun(value.run)
    await repository.saveTrial(value.trials[0]!)
    const result = await loadReleaseEvidence(repository, ['run'], 'v1')
    expect(result).toMatchObject({
      totalTokens: 15,
      tokenUsageCoverage: 1,
      p95LatencyMs: 100,
      suites: [{ total: 1, passed: 1 }],
    })
  })

  it('未完成运行、丢失试验、重复样本和错误归属都禁止构建证据', () => {
    const value = sample()
    for (const changed of [
      { ...value, run: { ...value.run, status: 'running' as const } },
      { ...value, trials: [] },
      { ...value, trials: [{ ...value.trials[0]!, runId: 'other' }] },
      { ...value, trials: [{ ...value.trials[0]!, resolved: false }] },
    ]) {
      expect(() => buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs: [changed] })).toThrow()
    }
    expect(() =>
      buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs: [value, value] }),
    ).toThrow()
  })

  it('旧结果缺失计量时覆盖率为零，矛盾计量不能伪装完整', () => {
    const value = sample()
    value.trials[0]!.metrics.tokenUsage = undefined
    expect(
      buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs: [value] }).tokenUsageCoverage,
    ).toBe(0)
    value.trials[0]!.metrics.tokenUsage = {
      status: 'complete',
      measuredRequests: 0,
      totalRequests: 1,
    }
    expect(() => buildReleaseEvidenceFromRuns({ agentVersion: 'v1', runs: [value] })).toThrow(
      'Invalid TrialResult',
    )
  })
})
