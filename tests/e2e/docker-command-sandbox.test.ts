import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { RunCommandTool } from '../../src/runtime/tools/builtins/run-command.js'
import { createSecurityServices } from '../../src/security/security-services.js'
import { WorkspacePolicy } from '../../src/runtime/workspace/workspace-policy.js'

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
