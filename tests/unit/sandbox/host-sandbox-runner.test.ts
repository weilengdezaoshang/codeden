import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostSandboxRunner } from '../../../packages/agent-runtime/src/sandbox/host-sandbox-runner.js'

describe('测试套件：HostSandboxRunner', () => {
  it('验证：命令结束后清理临时 HOME 目录', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'codeden-sandbox-test-'))
    try {
      const result = await new HostSandboxRunner().run(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write(process.env.HOME ?? "")'],
          timeoutMs: 5_000,
        },
        { workspaceRoot },
      )
      const home = result.stdout

      expect(home).not.toBe('')
      await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
