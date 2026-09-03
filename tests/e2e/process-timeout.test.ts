import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TemporaryWorkspaceAdapter } from '../../packages/agent-runtime/src/workspace/temporary-workspace.js'

describe('process group timeout', { timeout: 15_000 }, () => {
  it('A-4: times out and kills spawned descendants', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-kill-'))
    const pidFile = path.join(root, 'child.pid')
    await writeFile(path.join(root, 'keep.txt'), 'x', 'utf8')
    const workspace = await TemporaryWorkspaceAdapter.fromExisting(root, { deleteOnDispose: true })
    const script = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 200)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 200);
    `
    await expect(
      workspace.exec({
        command: process.execPath,
        args: ['-e', script],
        timeoutMs: 800,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const childPid = Number(await readFile(pidFile, 'utf8'))
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).toThrow()
    await workspace.dispose()
  })
})
