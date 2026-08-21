import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { RepositoryWorkspaceFactory } from '../../src/eval/adapters/workspaces/repository-workspace.factory.js'

const execFileAsync = promisify(execFile)

describe('RepositoryWorkspaceFactory', () => {
  it('checks out the base commit and applies the test patch before snapshotting', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'codeden-source-repo-'))
    await git(repository, ['init'])
    await git(repository, ['config', 'user.email', 'test@example.com'])
    await git(repository, ['config', 'user.name', 'Test'])
    await writeFile(path.join(repository, 'value.txt'), 'base\n')
    await git(repository, ['add', 'value.txt'])
    await git(repository, ['commit', '-m', 'base'])
    const { stdout } = await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD'])
    const baseCommit = stdout.trim()
    const factory = new RepositoryWorkspaceFactory({
      resolveRepositoryUrl: () => repository,
    })
    const workspace = await factory.create({
      path: 'owner/repo',
      repository: {
        repository: 'owner/repo',
        baseCommit,
        testPatch: [
          'diff --git a/value.txt b/value.txt',
          '--- a/value.txt',
          '+++ b/value.txt',
          '@@ -1 +1 @@',
          '-base',
          '+patched',
          '',
        ].join('\n'),
      },
    })

    expect(await workspace.readFile('value.txt')).toBe('patched\n')
    expect(await workspace.changedPaths()).toEqual([])
    expect(workspace.verificationCommandsAllowed).toBe(false)
    await workspace.dispose()
  })
})

async function git(repository: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', repository, ...args])
}
