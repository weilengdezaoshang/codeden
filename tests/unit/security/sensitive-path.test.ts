import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NoopEventSink } from '../../../src/core/events/event-sink.js'
import { ReadFileTool } from '../../../src/runtime/tools/builtins/read-file.js'
import { RunCommandTool } from '../../../src/runtime/tools/builtins/run-command.js'
import { WriteFileTool } from '../../../src/runtime/tools/builtins/write-file.js'
import { WorkspacePolicy } from '../../../src/runtime/workspace/workspace-policy.js'
import { ResolvedSecret } from '../../../src/security/resolved-secret.js'
import { SecretLeakGuard } from '../../../src/security/secret-leak-guard.js'
import { SecretRedactor } from '../../../src/security/secret-redactor.js'
import { InMemorySecretRegistry } from '../../../src/security/secret-registry.js'
import { SensitivePathPolicy } from '../../../src/security/sensitive-path-policy.js'
import type { ToolContext } from '../../../src/runtime/tools/tool.js'

const SENTINEL = ['codeden', 'secret', 'must', 'never', 'appear'].join('-')

async function ctx(): Promise<ToolContext & { root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-path-'))
  await writeFile(path.join(root, 'ok.txt'), 'hello', 'utf8')
  const registry = new InMemorySecretRegistry()
  registry.register(new ResolvedSecret(SENTINEL))
  const redactor = new SecretRedactor(registry)
  return {
    root,
    workspaceRoot: root,
    policy: new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: true,
    }),
    eventSink: new NoopEventSink(),
    security: {
      redactor,
      guard: new SecretLeakGuard(registry, redactor),
      paths: new SensitivePathPolicy(),
    },
  }
}

describe('sensitive path policy', () => {
  it('allows ordinary files', async () => {
    const context = await ctx()
    const result = await new ReadFileTool().execute({ path: 'ok.txt' }, context)
    expect(result.content).toBe('hello')
  })

  it.each([
    '.env',
    '.env.local',
    'src/../.env',
    'apps/web/.env',
    '.ssh/id_ed25519',
    '.codeden/config.local.yaml',
  ])('denies %s', async (target) => {
    const context = await ctx()
    await expect(new ReadFileTool().execute({ path: target }, context)).rejects.toMatchObject({
      code: 'WORKSPACE_SECRET_PATH_DENIED',
    })
  })

  it('denies writing a nested env file', async () => {
    const context = await ctx()
    await expect(
      new WriteFileTool().execute(
        { path: 'apps/web/.env', content: 'x', createParents: true },
        context,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_SECRET_PATH_DENIED' })
  })

  it('redacts a sentinel that appears in an ordinary file', async () => {
    const context = await ctx()
    await writeFile(path.join(context.root, 'note.txt'), `leak ${SENTINEL}`, 'utf8')
    const result = await new ReadFileTool().execute({ path: 'note.txt' }, context)
    expect(result.content).not.toContain(SENTINEL)
    expect(result.content).toContain('<redacted>')
  })

  it('rejects writing a known secret', async () => {
    const context = await ctx()
    await expect(
      new WriteFileTool().execute(
        { path: 'out.txt', content: SENTINEL, createParents: false },
        context,
      ),
    ).rejects.toMatchObject({ code: 'TOOL_OUTPUT_SECRET_DETECTED' })
  })

  it('denies run_command when a string argument names a secret file', async () => {
    const context = await ctx()
    await expect(
      new RunCommandTool().execute(
        {
          command: process.execPath,
          args: ['-e', "require('fs').writeFileSync('.env', 'x')"],
          timeoutMs: 5000,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_SECRET_PATH_DENIED' })
  })

  it('allows run_command that only inspects process.env', async () => {
    const context = await ctx()
    const output = await new RunCommandTool().execute(
      {
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify(process.env))'],
        timeoutMs: 5000,
      },
      context,
    )
    expect(output.exitCode).toBe(0)
  })
})
