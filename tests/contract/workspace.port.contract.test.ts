import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TemporaryWorkspaceAdapter } from '../../src/eval/adapters/workspaces/temporary-workspace.adapter.js'

describe('WorkspacePort contract', () => {
  it('round-trips reads and writes', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'codeden-fix-'))
    await writeFile(path.join(fixture, 'a.txt'), 'one', 'utf8')
    const workspace = await TemporaryWorkspaceAdapter.fromFixture(fixture)
    expect(await workspace.readFile('a.txt')).toBe('one')
    await workspace.writeFile('a.txt', 'two')
    expect(await workspace.readFile('a.txt')).toBe('two')
    await workspace.dispose()
  })

  it('reports changed paths against the initial snapshot', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'codeden-fix-'))
    await writeFile(path.join(fixture, 'a.txt'), 'one', 'utf8')
    const workspace = await TemporaryWorkspaceAdapter.fromFixture(fixture)
    expect(await workspace.changedPaths()).toEqual([])
    await workspace.writeFile('a.txt', 'two')
    await workspace.writeFile('b.txt', 'new')
    expect(await workspace.changedPaths()).toEqual(['a.txt', 'b.txt'])
    await workspace.dispose()
  })

  it('resets back to the fixture and leaves the fixture untouched', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'codeden-fix-'))
    await writeFile(path.join(fixture, 'a.txt'), 'one', 'utf8')
    const workspace = await TemporaryWorkspaceAdapter.fromFixture(fixture)
    await workspace.writeFile('a.txt', 'two')
    await workspace.reset()
    expect(await workspace.readFile('a.txt')).toBe('one')
    expect(await readFile(path.join(fixture, 'a.txt'), 'utf8')).toBe('one')
    await workspace.dispose()
  })

  it('does not leak process secrets to exec', async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'secret-key'
    try {
      const fixture = await mkdtemp(path.join(tmpdir(), 'codeden-fix-'))
      await writeFile(path.join(fixture, 'a.txt'), 'one', 'utf8')
      const workspace = await TemporaryWorkspaceAdapter.fromFixture(fixture)
      const result = await workspace.exec({
        command: process.execPath,
        args: ['-e', "process.stdout.write(process.env.OPENAI_API_KEY ?? '')"],
      })
      expect(result.stdout).toBe('')
      await workspace.dispose()
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previous
      }
    }
  })

  it('makes dispose idempotent', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'codeden-fix-'))
    await writeFile(path.join(fixture, 'a.txt'), 'one', 'utf8')
    const workspace = await TemporaryWorkspaceAdapter.fromFixture(fixture)
    await workspace.dispose()
    await expect(workspace.dispose()).resolves.toBeUndefined()
  })
})
