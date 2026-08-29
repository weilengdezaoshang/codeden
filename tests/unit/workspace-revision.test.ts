import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureWorkspaceRevision,
  parseWorkspaceRevision,
} from '../../src/runtime/attempts/workspace-revision.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-revision-'))
  roots.push(root)
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  await writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 2\n', 'utf8')
  return root
}

describe('测试套件：工作区版本', () => {
  it('验证：相同内容不受路径顺序和分隔符影响', async () => {
    const root = await createWorkspace()

    const first = await captureWorkspaceRevision({
      root,
      baseCommit: 'abc123',
      changedPaths: ['src/b.ts', './src/a.ts', 'src/a.ts'],
    })
    const second = await captureWorkspaceRevision({
      root,
      baseCommit: 'abc123',
      changedPaths: ['src\\a.ts', 'src/b.ts'],
    })

    expect(first.id).toBe(second.id)
    expect(first.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('验证：文件内容或基线提交变化会生成新的版本', async () => {
    const root = await createWorkspace()
    const initial = await captureWorkspaceRevision({ root, changedPaths: ['src/a.ts'] })

    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 3\n', 'utf8')
    const changed = await captureWorkspaceRevision({ root, changedPaths: ['src/a.ts'] })
    const changedBase = await captureWorkspaceRevision({
      root,
      baseCommit: 'new-base',
      changedPaths: ['src/a.ts'],
    })

    expect(changed.id).not.toBe(initial.id)
    expect(changedBase.id).not.toBe(changed.id)
  })

  it('验证：删除文件会作为版本内容参与摘要', async () => {
    const root = await createWorkspace()
    await rm(path.join(root, 'src', 'a.ts'))

    const revision = await captureWorkspaceRevision({ root, changedPaths: ['src/a.ts'] })

    expect(revision.files).toEqual([{ path: 'src/a.ts', exists: false }])
    expect(parseWorkspaceRevision(revision)).toEqual(revision)
  })

  it('验证：拒绝被篡改或包含重复路径的版本清单', async () => {
    const root = await createWorkspace()
    const revision = await captureWorkspaceRevision({ root, changedPaths: ['src/a.ts'] })

    expect(() => parseWorkspaceRevision({ ...revision, id: '0'.repeat(64) })).toThrow(
      'Workspace revision digest does not match its manifest',
    )
    expect(() =>
      parseWorkspaceRevision({
        ...revision,
        files: [revision.files[0], revision.files[0]],
      }),
    ).toThrow('Invalid workspace revision')
    expect(() =>
      parseWorkspaceRevision({
        ...revision,
        files: [{ ...revision.files[0], path: '../outside.ts' }],
      }),
    ).toThrow('Invalid workspace revision')
  })

  it('验证：拒绝绝对路径和逃逸工作区的路径', async () => {
    const root = await createWorkspace()

    await expect(
      captureWorkspaceRevision({ root, changedPaths: ['../outside.ts'] }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_DENIED' })
    await expect(
      captureWorkspaceRevision({ root, changedPaths: ['/tmp/outside.ts'] }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_DENIED' })
  })

  it('验证：支持根目录真实路径与输入路径不同的工作区', async () => {
    const root = await createWorkspace()
    const revision = await captureWorkspaceRevision({ root, changedPaths: ['src/a.ts'] })

    expect(revision.files[0]?.path).toBe('src/a.ts')
  })
})
