import { describe, expect, it } from 'vitest'
import { parseTaskSpec } from '../../src/core/task/task-spec.js'
import { verifyCommands } from '../../src/runtime/verification/command-verifier.js'

describe('verifyCommands', () => {
  it('skips when no commands are configured', async () => {
    const result = await verifyCommands(parseTaskSpec({ id: 't', goal: 'g' }), async () => {
      throw new Error('should not run')
    })
    expect(result.passed).toBe(true)
  })

  it('fails on a non-zero exit code', async () => {
    const result = await verifyCommands(
      parseTaskSpec({
        id: 't',
        goal: 'g',
        verificationCommands: ['pnpm test'],
      }),
      async () => ({ exitCode: 1, stdout: '', stderr: 'boom', durationMs: 1 }),
    )
    expect(result.passed).toBe(false)
    expect(result.message).toContain('pnpm test')
  })
})
