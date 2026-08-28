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

describe('测试套件：reportAgentResult', () => {
  it('验证：returns zero for a verified result without conflicts', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = reportAgentResult({
      result: { ...baseResult, status: 'verified_complete' },
      apply: { applied: ['src/a.ts'], unchanged: [], conflicts: [] },
      redactor,
    })
    expect(code).toBe(0)
    expect(output).toHaveBeenCalledWith('VERIFIED_COMPLETE')
    output.mockRestore()
  })

  it('验证：returns one when writeback has conflicts', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = reportAgentResult({
      result: {
        ...baseResult,
        status: 'verified_complete',
        submission: { type: 'files', changedPaths: ['src/a.ts'] },
      },
      apply: { applied: [], unchanged: [], conflicts: ['src/a.ts'], patchPath: '/tmp/last.patch' },
      redactor,
    })
    expect(code).toBe(1)
    expect(output).toHaveBeenCalledWith('Status: conflict')
    output.mockRestore()
  })

  it('验证：returns one and prints verification evidence on failure', () => {
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

  it('验证：超时失败输出资源用量和可执行的下一步建议', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = reportAgentResult({
      result: {
        ...baseResult,
        status: 'timeout',
        metrics: emptyMetrics({ turns: 8, toolCalls: 4, durationMs: 1234 }),
      },
      redactor,
    })
    expect(code).toBe(1)
    expect(output).toHaveBeenCalledWith('Reason: done')
    expect(output).toHaveBeenCalledWith('Usage: 8 turns, 4 tool calls, 1234ms')
    expect(output).toHaveBeenCalledWith('Next: Retry with a larger timeout or a smaller task.')
    output.mockRestore()
  })
})
