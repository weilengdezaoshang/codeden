import { describe, expect, it } from 'vitest'
import { parseTaskSpec } from '../../src/core/task/task-spec.js'
import { parseVerificationPlan } from '../../src/core/task/verification-plan.js'

describe('测试套件：VerificationPlan', () => {
  it('将旧版验证命令自动转换为结构化步骤', () => {
    const task = parseTaskSpec({
      id: 'task-1',
      goal: '修复',
      verificationCommands: ['pnpm test', 'pnpm typecheck'],
    })

    expect(task.verificationPlan.steps[0]).toEqual(
      expect.objectContaining({ id: 'workspace-diff', kind: 'diff', source: 'system' }),
    )
    expect(task.verificationPlan.steps.slice(1)).toEqual([
      expect.objectContaining({
        id: 'legacy-command-1',
        kind: 'command',
        command: 'pnpm test',
        source: 'legacy',
        required: true,
        timeoutMs: 30_000,
      }),
      expect.objectContaining({ id: 'legacy-command-2', command: 'pnpm typecheck' }),
    ])
  })

  it('拒绝重复步骤标识和缺少命令的执行步骤', () => {
    expect(() =>
      parseVerificationPlan({
        schemaVersion: 1,
        steps: [
          { id: 'same', kind: 'command', command: 'pnpm test' },
          { id: 'same', kind: 'test', command: 'pnpm test' },
        ],
      }),
    ).toThrow('Invalid verification plan')
    expect(() =>
      parseVerificationPlan({
        schemaVersion: 1,
        steps: [{ id: 'missing-command', kind: 'test' }],
      }),
    ).toThrow('Invalid verification plan')
  })

  it('拒绝可选或重复的工作区差异门禁', () => {
    expect(() =>
      parseVerificationPlan({
        schemaVersion: 1,
        steps: [{ id: 'diff', kind: 'diff', required: false }],
      }),
    ).toThrow('Invalid verification plan')
    expect(() =>
      parseVerificationPlan({
        schemaVersion: 1,
        steps: [
          { id: 'diff-1', kind: 'diff' },
          { id: 'diff-2', kind: 'diff' },
        ],
      }),
    ).toThrow('Invalid verification plan')
  })
})
