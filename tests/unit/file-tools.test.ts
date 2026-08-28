import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { EditFileTool } from '../../src/runtime/tools/builtins/edit-file.js'
import { ReadFileTool } from '../../src/runtime/tools/builtins/read-file.js'
import { WriteFileTool } from '../../src/runtime/tools/builtins/write-file.js'
import { WorkspacePolicy } from '../../src/runtime/workspace/workspace-policy.js'
import type { ToolContext } from '../../src/runtime/tools/tool.js'

async function context(): Promise<ToolContext & { root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-tools-'))
  await writeFile(path.join(root, 'note.txt'), 'alpha beta alpha', 'utf8')
  return {
    root,
    workspaceRoot: root,
    policy: new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: false,
    }),
    eventSink: new NoopEventSink(),
  }
}

describe('测试套件：file tools', () => {
  it('验证：reads a text file', async () => {
    const ctx = await context()
    const result = await new ReadFileTool().execute({ path: 'note.txt' }, ctx)
    expect(result.content).toContain('alpha')
  })

  it('验证：writes a file without creating missing parents by default', async () => {
    const ctx = await context()
    await expect(
      new WriteFileTool().execute(
        { path: 'nested/a.txt', content: 'x', createParents: false },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_IO_FAILED' })
  })

  it('验证：fails edit when oldText matches zero or multiple times and leaves the file unchanged', async () => {
    const ctx = await context()
    const tool = new EditFileTool()
    await expect(
      tool.execute({ path: 'note.txt', oldText: 'missing', newText: 'x' }, ctx),
    ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' })
    await expect(
      tool.execute({ path: 'note.txt', oldText: 'alpha', newText: 'gamma' }, ctx),
    ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' })
    expect(await readFile(path.join(ctx.root, 'note.txt'), 'utf8')).toBe('alpha beta alpha')
  })

  it('验证：replaces a unique occurrence', async () => {
    const ctx = await context()
    await new EditFileTool().execute({ path: 'note.txt', oldText: 'beta', newText: 'delta' }, ctx)
    expect(await readFile(path.join(ctx.root, 'note.txt'), 'utf8')).toBe('alpha delta alpha')
  })

  it('验证：inserts dollar signs in newText literally', async () => {
    const ctx = await context()
    await new EditFileTool().execute(
      { path: 'note.txt', oldText: 'beta', newText: 'price $$ $& $1' },
      ctx,
    )
    expect(await readFile(path.join(ctx.root, 'note.txt'), 'utf8')).toBe(
      'alpha price $$ $& $1 alpha',
    )
  })
})
