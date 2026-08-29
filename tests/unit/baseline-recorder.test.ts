import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseTaskSpec } from '../../src/core/task/task-spec.js'
import { captureBaseline } from '../../src/runtime/verification/baseline-recorder.js'

describe('测试套件：验证基线记录', () => {
  it('基线只运行会阻断完成的必选步骤', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-baseline-'))
    try {
      const exec = vi.fn(async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
      await captureBaseline(
        parseTaskSpec({
          id: 'task',
          goal: '修复',
          verificationPlan: {
            schemaVersion: 1,
            steps: [
              { id: 'test', kind: 'test', command: 'pnpm test', required: true },
              { id: 'lint', kind: 'lint', command: 'pnpm lint', required: false },
            ],
          },
        }),
        { root, changedPaths: async () => [], exec },
      )

      expect(exec).toHaveBeenCalledOnce()
      expect(exec).toHaveBeenCalledWith({
        command: 'pnpm',
        args: ['test'],
        timeoutMs: 30_000,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
