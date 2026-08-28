import { describe, expect, it } from 'vitest'
import { emptyMetrics } from '../../src/eval/domain/metrics.js'
import { summarize } from '../../src/eval/application/eval-runner.js'
import { ConsoleReporter } from '../../src/eval/reporters/console.reporter.js'

describe('测试套件：ConsoleReporter', () => {
  it('验证：prints the trial fields used by the eval CLI', () => {
    const lines: string[] = []
    const reporter = new ConsoleReporter((line) => lines.push(line))
    reporter.report(
      summarize(
        'run',
        [
          {
            schemaVersion: 1,
            runId: 'run',
            trialId: 'trial',
            caseId: 'update-package-version',
            execution: { status: 'submitted' },
            submission: { status: 'valid' },
            verification: { status: 'passed' },
            infrastructure: { status: 'ok' },
            resolved: true,
            scores: {},
            metrics: emptyMetrics({ durationMs: 42, turns: 3, toolCalls: 2 }),
            artifacts: [],
          },
        ],
        42,
      ),
      'codeden/mock-model',
    )
    expect(lines.join('\n')).toContain('Case: update-package-version')
    expect(lines.join('\n')).toContain('Agent: codeden/mock-model')
    expect(lines.join('\n')).toContain('Resolved: yes')
    expect(lines.join('\n')).toContain('Turns: 3')
    expect(lines.join('\n')).toContain('Tool calls: 2')
  })

  it('验证：失败试验输出归因、失败身份和指纹', () => {
    const lines: string[] = []
    const reporter = new ConsoleReporter((line) => lines.push(line))
    reporter.report(
      summarize(
        'run',
        [
          {
            schemaVersion: 1,
            runId: 'run',
            trialId: 'trial',
            caseId: 'failed-case',
            execution: { status: 'submitted' },
            submission: { status: 'valid' },
            verification: { status: 'failed' },
            infrastructure: { status: 'ok' },
            failure: {
              category: 'verification',
              message: '提交未通过验证器',
              identities: ['should add value'],
              fingerprint: '0123456789abcdef',
              evidence: ['断言失败'],
            },
            resolved: false,
            scores: {},
            metrics: emptyMetrics({ durationMs: 42 }),
            artifacts: [],
          },
        ],
        42,
      ),
      'codeden/mock-model',
    )
    expect(lines.join('\n')).toContain('Failure: verification - 提交未通过验证器')
    expect(lines.join('\n')).toContain('Failing identities: should add value')
    expect(lines.join('\n')).toContain('Failure fingerprint: 0123456789abcdef')
  })
})
