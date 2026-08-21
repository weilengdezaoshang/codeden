import { describe, expect, it, vi } from 'vitest'
import { InMemorySecretRegistry } from '../../src/security/secret-registry.js'
import { SecretRedactor } from '../../src/security/secret-redactor.js'
import { reportAgentResult } from '../../src/cli/agent-result-reporter.js'
import { emptyMetrics } from '../../src/eval/domain/metrics.js'

const redactor = new SecretRedactor(new InMemorySecretRegistry())
const baseResult = {
  stopReason: 'done',
  finalResponse: '',
  metrics: emptyMetrics(),
}

describe('reportAgentResult', () => {
  it('returns zero for a verified result without conflicts', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = reportAgentResult({
      result: { ...baseResult, status: 'verified_complete' },
      apply: { applied: ['src/a.ts'], conflicts: [] },
      redactor,
    })
    expect(code).toBe(0)
    expect(output).toHaveBeenCalledWith('VERIFIED_COMPLETE')
    output.mockRestore()
  })

  it('returns one when writeback has conflicts', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = reportAgentResult({
      result: {
        ...baseResult,
        status: 'verified_complete',
        submission: { type: 'files', changedPaths: ['src/a.ts'] },
      },
      apply: { applied: [], conflicts: ['src/a.ts'], patchPath: '/tmp/last.patch' },
      redactor,
    })
    expect(code).toBe(1)
    expect(output).toHaveBeenCalledWith('Status: conflict')
    output.mockRestore()
  })

  it('returns one and prints verification evidence on failure', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = reportAgentResult({
      result: { ...baseResult, status: 'submitted' },
      lastCheck: { passed: false, message: 'check failed', evidence: ['missing test'] },
      redactor,
    })
    expect(code).toBe(1)
    expect(output).toHaveBeenCalledWith('check failed')
    expect(output).toHaveBeenCalledWith('missing test')
    output.mockRestore()
  })
})
