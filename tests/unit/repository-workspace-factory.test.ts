import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { RepositoryWorkspaceFactory } from '../../packages/eval-engine/src/adapters/workspaces/repository-workspace.factory.js'

const execFileAsync = promisify(execFile)

describe('测试套件：RepositoryWorkspaceFactory', () => {
  it('验证：checks out the base commit and applies the test patch before snapshotting', async () => {
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

    const agentWorkspace = await new RepositoryWorkspaceFactory({
      resolveRepositoryUrl: () => repository,
      applyTestPatch: false,
    }).create({
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
    expect(await agentWorkspace.readFile('value.txt')).toBe('base\n')
    await agentWorkspace.dispose()
  })

  it('验证：评测仓库工作区复用注入的统一沙箱', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'codeden-source-repo-'))
    await git(repository, ['init'])
    await git(repository, ['config', 'user.email', 'test@example.com'])
    await git(repository, ['config', 'user.name', 'Test'])
    await writeFile(path.join(repository, 'value.txt'), 'base\n')
    await git(repository, ['add', 'value.txt'])
    await git(repository, ['commit', '-m', 'base'])
    const { stdout } = await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD'])
    const baseCommit = stdout.trim()
    let calls = 0
    let disposed = false
    const runner = {
      async run(_command: unknown, context: { redact?: (value: string) => string }) {
        calls += 1
        return {
          exitCode: 0,
          stdout: context.redact?.('sentinel-secret') ?? 'sentinel-secret',
          stderr: '',
          durationMs: 1,
        }
      },
      async dispose() {
        disposed = true
      },
    }
    const factory = new RepositoryWorkspaceFactory({
      resolveRepositoryUrl: () => repository,
      commandOptions: { runner },
      sandboxRedact: (value) => value.replace('sentinel-secret', '<redacted>'),
    })
    const workspace = await factory.create({
      path: 'owner/repo',
      repository: { repository: 'owner/repo', baseCommit, testPatch: '' },
    })

    await expect(
      workspace.exec({ command: 'node', args: [], timeoutMs: 1000 }),
    ).resolves.toMatchObject({
      stdout: '<redacted>',
    })
    await workspace.dispose()

    expect(calls).toBe(1)
    expect(disposed).toBe(true)
  })

  it('验证：评测工作区初始化失败时释放已创建的沙箱', async () => {
    let disposed = false
    const runner = {
      async run() {
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
      },
      async dispose() {
        disposed = true
      },
    }
    const factory = new RepositoryWorkspaceFactory({
      resolveRepositoryUrl: () => path.join(tmpdir(), 'codeden-missing-repository'),
      commandOptions: { runner },
    })

    await expect(
      factory.create({
        path: 'owner/repo',
        repository: {
          repository: 'owner/repo',
          baseCommit: 'a'.repeat(40),
          testPatch: '',
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_SETUP_FAILED' })
    expect(disposed).toBe(true)
  })

  it('验证：多个仓库工作区可以并发从同一基线提交初始化', async () => {
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
      repositorySetupTimeoutMs: 10_000,
    })

    const workspaces = await Promise.all(
      Array.from({ length: 4 }, () =>
        factory.create({
          path: 'owner/repo',
          repository: { repository: 'owner/repo', baseCommit, testPatch: '' },
        }),
      ),
    )

    await expect(
      Promise.all(workspaces.map((workspace) => workspace.readFile('value.txt'))),
    ).resolves.toEqual(['base\n', 'base\n', 'base\n', 'base\n'])
    await Promise.all(workspaces.map((workspace) => workspace.dispose()))
  })

  it('验证：已取消的仓库工作区不会继续初始化', async () => {
    const controller = new AbortController()
    controller.abort(new Error('USER_CANCELLED'))
    const factory = new RepositoryWorkspaceFactory({
      resolveRepositoryUrl: () => '/不存在的仓库',
    })

    await expect(
      factory.create(
        {
          path: 'owner/repo',
          repository: {
            repository: 'owner/repo',
            baseCommit: 'a'.repeat(40),
            testPatch: '',
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('USER_CANCELLED')
  })
})

async function git(repository: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', repository, ...args])
}
