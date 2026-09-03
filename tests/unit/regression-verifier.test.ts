import { describe, expect, it } from 'vitest'
import { compareBaseline } from '../../packages/agent-runtime/src/verification/regression-verifier.js'
import type { BaselineSnapshot } from '../../packages/agent-runtime/src/verification/baseline-snapshot.js'

const baseline: BaselineSnapshot = {
  command: 'node --test tests',
  exitCode: 1,
  failing: ['tests/old-fail.test.js'],
  testFiles: ['tests/old-fail.test.js', 'tests/ok.test.js'],
}

describe('测试套件：compareBaseline', () => {
  it('验证：A-6: identical failing identities pass', () => {
    const result = compareBaseline(baseline, {
      exitCode: 1,
      failing: ['tests/old-fail.test.js'],
    })
    expect(result.passed).toBe(true)
  })

  it('验证：treats new failing identities as regressions', () => {
    const result = compareBaseline(baseline, {
      exitCode: 1,
      failing: ['tests/old-fail.test.js', 'tests/ok.test.js'],
    })
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain('tests/ok.test.js')
  })

  it('验证：passes when a baseline failure is fixed and no new ones appear', () => {
    const result = compareBaseline(
      { ...baseline, failing: ['tests/old-fail.test.js', 'tests/answer.test.js'] },
      { exitCode: 1, failing: ['tests/old-fail.test.js'] },
    )
    expect(result.passed).toBe(true)
  })

  it('验证：uses fingerprints when no identities were parsed', () => {
    const same = compareBaseline(
      { ...baseline, failing: [], fingerprint: 'abc' },
      { exitCode: 1, failing: [], fingerprint: 'abc' },
    )
    expect(same.passed).toBe(true)
    const changed = compareBaseline(
      { ...baseline, failing: [], fingerprint: 'abc' },
      { exitCode: 1, failing: [], fingerprint: 'zzz' },
    )
    expect(changed.passed).toBe(false)
  })
})
