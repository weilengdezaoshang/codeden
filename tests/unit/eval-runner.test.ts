import { describe, expect, it } from 'vitest'
import { groupFailureClusters } from '../../packages/eval-engine/src/application/eval-runner.js'
import { emptyMetrics } from '../../packages/core/src/metrics.js'
import type { TrialResult } from '../../packages/eval-engine/src/domain/trial-result.js'

function failedTrial(
  caseId: string,
  fingerprint: string | undefined,
  layer: 'verifier' | 'model' = 'verifier',
): TrialResult {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    trialId: `trial-${caseId}`,
    caseId,
    execution: { status: 'submitted' },
    submission: { status: 'valid' },
    verification: { status: 'failed' },
    infrastructure: { status: 'ok' },
    failure: {
      category: layer === 'model' ? 'agent' : 'verification',
      message: '评测失败',
      identities: [],
      ...(fingerprint ? { fingerprint } : {}),
      evidence: [],
      diagnosis: {
        layer,
        stage: layer === 'model' ? 'model_generation' : 'verification',
        rootCause: '测试根因',
        suggestion: '检查相关日志',
        confidence: 0.8,
        evidenceRefs: [],
      },
    },
    resolved: false,
    scores: {},
    metrics: emptyMetrics({}),
    artifacts: [],
  }
}

describe('测试套件：评测失败聚类', () => {
  it('验证：相同诊断层和指纹的失败会聚合', () => {
    const clusters = groupFailureClusters([
      failedTrial('case-a', 'aaaaaaaaaaaaaaaa'),
      failedTrial('case-b', 'aaaaaaaaaaaaaaaa'),
      failedTrial('case-c', 'bbbbbbbbbbbbbbbb'),
    ])

    expect(clusters).toHaveLength(2)
    expect(clusters[0]).toMatchObject({
      count: 2,
      caseIds: ['case-a', 'case-b'],
      category: 'verification',
      layer: 'verifier',
      stage: 'verification',
      fingerprint: 'aaaaaaaaaaaaaaaa',
    })
  })

  it('验证：不同诊断层即使指纹相同也不会错误合并', () => {
    const clusters = groupFailureClusters([
      failedTrial('case-a', 'aaaaaaaaaaaaaaaa', 'verifier'),
      failedTrial('case-b', 'aaaaaaaaaaaaaaaa', 'model'),
    ])

    expect(clusters).toHaveLength(2)
    expect(clusters.map((cluster) => cluster.layer)).toEqual(['model', 'verifier'])
  })

  it('验证：没有失败或没有诊断时使用稳定的未知位置聚类', () => {
    const passed: TrialResult = {
      ...failedTrial('passed', undefined),
      failure: undefined,
      resolved: true,
      verification: { status: 'passed' },
    }
    const withFailureWithoutDiagnosis = failedTrial('case-a', undefined)
    withFailureWithoutDiagnosis.failure = {
      ...withFailureWithoutDiagnosis.failure!,
      diagnosis: undefined,
    }
    const clusters = groupFailureClusters([passed, withFailureWithoutDiagnosis])

    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toMatchObject({
      count: 1,
      category: 'verification',
      key: 'verification:unknown:unknown:no-fingerprint',
    })
  })
})
