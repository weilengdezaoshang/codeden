import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { RunCommandTool } from '../../src/runtime/tools/builtins/run-command.js'
import { createSecurityServices } from '../../src/security/security-services.js'
import { WorkspacePolicy } from '../../src/runtime/workspace/workspace-policy.js'
import { TemporaryWorkspaceAdapter } from '../../src/eval/adapters/workspaces/temporary-workspace.adapter.js'

const execFileAsync = promisify(execFile)
const enabled = process.env.CODEDEN_DOCKER_TESTS === '1'
let dockerAvailable = false

describe.skipIf(!enabled)('docker command sandbox', () => {
  beforeAll(async () => {
    try {
      await execFileAsync('docker', ['info'])
      dockerAvailable = true
    } catch {
      dockerAvailable = false
    }
  })

  it('blocks network access while allowing workspace execution', async () => {
    if (!dockerAvailable) {
      return
    }
    const result = await new RunCommandTool({ mode: 'docker' }).execute(
      {
        command: 'node',
        args: [
          '-e',
          "require('fs').accessSync('package.json'); fetch('https://example.com').then(() => process.exit(2)).catch(() => process.exit(0))",
        ],
        timeoutMs: 10_000,
      },
      context(),
    )
    expect(result.exitCode).toBe(0)
  })

  it('runs as non-root with an isolated writable temporary directory', async () => {
    if (!dockerAvailable) {
      return
    }
    const result = await new RunCommandTool({ mode: 'docker' }).execute(
      {
        command: 'node',
        args: [
          '-e',
          "if (process.getuid?.() === 0) process.exit(2); require('fs').writeFileSync('/tmp/codeden-sandbox-check', 'ok'); process.exit(0)",
        ],
        timeoutMs: 10_000,
      },
      context(),
    )
    expect(result.exitCode).toBe(0)
  })

  it('验证：Workspace 适配器通过 Docker 沙箱访问挂载目录', async () => {
    if (!dockerAvailable) {
      return
    }
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-docker-workspace-'))
    const workspace = await TemporaryWorkspaceAdapter.fromExisting(root, {
      sandboxOptions: { mode: 'docker' },
    })
    try {
      await expect(
        workspace.exec({
          command: 'node',
          args: ['-e', "require('fs').writeFileSync('/workspace/docker-check.txt', 'ok')"],
          timeoutMs: 10_000,
        }),
      ).resolves.toMatchObject({ exitCode: 0 })
      await expect(readFile(path.join(root, 'docker-check.txt'), 'utf8')).resolves.toBe('ok')
    } finally {
      await workspace.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('denies writes when the workspace mount is read-only', async () => {
    if (!dockerAvailable) {
      return
    }
    const result = await new RunCommandTool({ mode: 'docker', readOnly: true }).execute(
      {
        command: 'node',
        args: [
          '-e',
          "require('fs').writeFileSync('/workspace/.codeden-readonly-check', 'blocked')",
        ],
        timeoutMs: 10_000,
      },
      context(),
    )
    expect(result.exitCode).not.toBe(0)
  })

  it('returns a command timeout and does not leave the call pending', async () => {
    if (!dockerAvailable) {
      return
    }
    await expect(
      new RunCommandTool({ mode: 'docker' }).execute(
        { command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 100 },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' })
  })
})

function context() {
  const security = createSecurityServices()
  const workspaceRoot = process.cwd()
  return {
    workspaceRoot,
    policy: new WorkspacePolicy(workspaceRoot, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: true,
    }),
    eventSink: new NoopEventSink(),
    security: {
      redactor: security.redactor,
      guard: security.guard,
      paths: security.paths,
    },
  }
}
