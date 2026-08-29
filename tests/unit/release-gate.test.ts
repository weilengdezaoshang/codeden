import { describe, expect, it } from 'vitest'
import { evaluateReleaseGate } from '../../src/optimization/release-gate.js'

describe('测试套件：Champion Challenger 发布门禁', () => {
  it('评分器或数据集不一致时禁止模型晋级', () => {
    const decision = evaluateReleaseGate(evidence(), {
      ...evidence('challenger'),
      graderDigest: 'f'.repeat(64),
      suites: suites({ holdout: 99 }),
    })

    expect(decision.promote).toBe(false)
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ id: 'evidence.same_grader', passed: false, blocking: true }),
    )
  })

  it('holdout 通过率回退时禁止晋级', () => {
    const decision = evaluateReleaseGate(evidence(), {
      ...evidence('challenger'),
      suites: suites({ holdout: 94 }),
    })

    expect(decision.promote).toBe(false)
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ id: 'quality.suite_non_regression', passed: false }),
    )
  })

  it('缺少回归集或校验集证据时禁止晋级', () => {
    const decision = evaluateReleaseGate(evidence(), {
      ...evidence('challenger'),
      suites: [suite('holdout', 100, 99)],
    })

    expect(decision.promote).toBe(false)
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ id: 'evidence.suite_coverage', passed: false, blocking: true }),
    )
  })

  it('非 holdout 评测集回退时也禁止晋级', () => {
    const decision = evaluateReleaseGate(evidence(), {
      ...evidence('challenger'),
      suites: suites({ regression: 18, holdout: 99 }),
    })

    expect(decision.promote).toBe(false)
    expect(decision.checks).toContainEqual(
      expect.objectContaining({
        id: 'quality.suite_non_regression',
        passed: false,
        blocking: true,
      }),
    )
  })

  it('Champion 和 Challenger 样本数不一致时禁止晋级', () => {
    const decision = evaluateReleaseGate(evidence(), {
      ...evidence('challenger'),
      suites: [suite('regression', 21, 20), suite('validation', 20, 19), suite('holdout', 100, 99)],
    })

    expect(decision.promote).toBe(false)
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ id: 'evidence.suite_coverage', passed: false, blocking: true }),
    )
  })

  it('样本数相同但样本集指纹不一致时禁止晋级', () => {
    const challengerSuites = suites({ holdout: 99 })
    challengerSuites[2] = { ...challengerSuites[2]!, caseSetDigest: '9'.repeat(64) }

    const decision = evaluateReleaseGate(evidence(), {
      ...evidence('challenger'),
      suites: challengerSuites,
    })

    expect(decision.promote).toBe(false)
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ id: 'evidence.suite_coverage', passed: false, blocking: true }),
    )
  })

  it('运行环境不一致时禁止晋级', () => {
    const decision = evaluateReleaseGate(evidence(), {
      ...evidence('challenger'),
      environmentDigest: '8'.repeat(64),
      suites: suites({ holdout: 99 }),
    })

    expect(decision.promote).toBe(false)
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ id: 'evidence.same_environment', passed: false, blocking: true }),
    )
  })

  it('非法或空的发布策略不能绕过必需门禁', () => {
    expect(() => evaluateReleaseGate(evidence(), evidence(), { requiredSuites: [] })).toThrow(
      'Invalid release gate policy',
    )
    expect(() =>
      evaluateReleaseGate(evidence(), evidence(), { maxInfrastructureFailureRate: 2 }),
    ).toThrow('Invalid release gate policy')
  })

  it('只更换版本名而 Agent 配置摘要未变时禁止晋级', () => {
    const decision = evaluateReleaseGate(evidence(), {
      ...evidence(),
      agentVersion: 'renamed-challenger',
      suites: suites({ holdout: 99 }),
    })

    expect(decision.promote).toBe(false)
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ id: 'evidence.distinct_agent', passed: false, blocking: true }),
    )
  })

  it('质量不回退但延迟升高时允许晋级并产生告警', () => {
    const decision = evaluateReleaseGate(evidence(), {
      ...evidence('challenger'),
      suites: suites({ holdout: 99 }),
      p95LatencyMs: 14_000,
    })

    expect(decision.promote).toBe(true)
    expect(decision.warnings).toContainEqual(
      expect.objectContaining({ id: 'efficiency.latency', passed: false, blocking: false }),
    )
  })
})

function evidence(agentVersion = 'champion') {
  return {
    schemaVersion: 1 as const,
    agentVersion,
    agentDigest: (agentVersion === 'champion' ? '1' : '2').repeat(64),
    datasetDigest: 'a'.repeat(64),
    graderDigest: 'b'.repeat(64),
    environmentDigest: 'c'.repeat(64),
    suites: suites(),
    infrastructureFailures: 0,
    totalTokens: 100_000,
    p95LatencyMs: 10_000,
  }
}

function suites(passed: { regression?: number; validation?: number; holdout?: number } = {}) {
  return [
    suite('regression', 20, passed.regression ?? 20),
    suite('validation', 20, passed.validation ?? 19),
    suite('holdout', 100, passed.holdout ?? 98),
  ]
}

function suite(name: 'regression' | 'validation' | 'holdout', total: number, passed: number) {
  return { name, total, passed, caseSetDigest: digestForSuite(name) }
}

function digestForSuite(name: 'regression' | 'validation' | 'holdout') {
  return { regression: 'd', validation: 'e', holdout: 'f' }[name].repeat(64)
}
