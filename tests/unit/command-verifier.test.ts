import { describe, expect, it } from 'vitest'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import { verifyCommands } from '../../packages/agent-runtime/src/verification/command-verifier.js'

describe('测试套件：verifyCommands', () => {
  it('验证：skips when no commands are configured', async () => {
    const result = await verifyCommands(parseTaskSpec({ id: 't', goal: 'g' }), async () => {
      throw new Error('should not run')
    })
    expect(result.passed).toBe(true)
  })

  it('验证：fails on a non-zero exit code', async () => {
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
    expect(result.evidence.join('\n')).toContain('boom')
  })

  it('按计划超时执行并记录每个步骤的结果', async () => {
    const commands: Array<{ command: string; timeoutMs?: number }> = []
    const result = await verifyCommands(
      parseTaskSpec({
        id: 't',
        goal: 'g',
        verificationPlan: {
          schemaVersion: 1,
          steps: [
            {
              id: 'optional-lint',
              kind: 'lint',
              command: 'pnpm lint',
              source: 'project',
              required: false,
              timeoutMs: 12_345,
            },
            {
              id: 'required-test',
              kind: 'test',
              command: 'pnpm test',
              source: 'project',
              required: true,
              timeoutMs: 54_321,
            },
          ],
        },
      }),
      async (command) => {
        commands.push(command)
        return {
          exitCode: command.args?.includes('lint') ? 1 : 0,
          stdout: '',
          stderr: '',
          durationMs: 7,
        }
      },
    )

    expect(result.passed).toBe(true)
    expect(commands).toEqual([
      { command: 'pnpm', args: ['lint'], timeoutMs: 12_345 },
      { command: 'pnpm', args: ['test'], timeoutMs: 54_321 },
    ])
    expect(result.stepResults).toEqual([
      expect.objectContaining({ stepId: 'optional-lint', status: 'failed', required: false }),
      expect.objectContaining({ stepId: 'required-test', status: 'passed', required: true }),
    ])
  })

  it('必选命令异常时阻断完成并标记后续步骤跳过', async () => {
    const result = await verifyCommands(
      parseTaskSpec({
        id: 't',
        goal: 'g',
        verificationPlan: {
          schemaVersion: 1,
          steps: [
            { id: 'test', kind: 'test', command: 'pnpm test', required: true },
            { id: 'build', kind: 'build', command: 'pnpm build', required: true },
          ],
        },
      }),
      async () => {
        throw new Error('runner unavailable')
      },
    )

    expect(result.passed).toBe(false)
    expect(result.stepResults).toEqual([
      expect.objectContaining({ stepId: 'test', status: 'error' }),
      expect.objectContaining({ stepId: 'build', status: 'skipped' }),
    ])
  })
})
