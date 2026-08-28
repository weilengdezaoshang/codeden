import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspacePolicy } from '../../src/runtime/workspace/workspace-policy.js'

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-policy-'))
  await writeFile(path.join(root, 'ok.txt'), 'ok', 'utf8')
  return root
}

describe('测试套件：WorkspacePolicy', () => {
  it('验证：allows in-workspace reads and writes', async () => {
    const root = await makeRoot()
    const policy = new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: false,
    })
    await expect(policy.resolveReadable('ok.txt')).resolves.toContain(`${path.sep}ok.txt`)
    await expect(policy.resolveWritable('ok.txt')).resolves.toContain(`${path.sep}ok.txt`)
  })

  it('验证：rejects ../ escape', async () => {
    const root = await makeRoot()
    const policy = new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: false,
    })
    await expect(policy.resolveReadable('../secret')).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_DENIED',
    })
  })

  it('验证：rejects an absolute path outside the workspace', async () => {
    const root = await makeRoot()
    const policy = new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: false,
    })
    await expect(policy.resolveWritable('/tmp/outside.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_DENIED',
    })
  })

  it('验证：rejects a symlink that escapes the workspace', async () => {
    const root = await makeRoot()
    const outside = await mkdtemp(path.join(tmpdir(), 'codeden-outside-'))
    const target = path.join(outside, 'secret.txt')
    await writeFile(target, 'secret', 'utf8')
    await symlink(target, path.join(root, 'link.txt'))
    const policy = new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: false,
    })
    await expect(policy.resolveReadable('link.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_DENIED',
    })
  })

  it('验证：rejects writes outside authorized roots', async () => {
    const root = await makeRoot()
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'a.ts'), 'a', 'utf8')
    const policy = new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['src'],
      allowCommands: false,
    })
    await expect(policy.resolveWritable('ok.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_DENIED',
    })
    await expect(policy.resolveWritable('src/a.ts')).resolves.toContain(
      `${path.sep}src${path.sep}a.ts`,
    )
  })
})
