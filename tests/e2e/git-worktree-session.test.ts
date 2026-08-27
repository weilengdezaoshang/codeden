import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitWorktreeSession } from '../../src/runtime/workspace/git-worktree-session.js'
import { createSecurityServices } from '../../src/security/security-services.js'
import { ResolvedSecret } from '../../src/security/resolved-secret.js'

const execFileAsync = promisify(execFile)

describe('GitWorktreeSession', { timeout: 20_000 }, () => {
  it('A-1: without git it runs in place', async () => {
    const origin = await emptyDir()
    await writeFile(path.join(origin, 'a.txt'), 'origin', 'utf8')
    const session = await GitWorktreeSession.open(origin)
    expect(session.isolated).toBe(false)
    await session.workspace.writeFile('a.txt', 'changed')
    expect(await readFile(path.join(origin, 'a.txt'), 'utf8')).toBe('changed')
    await session.dispose()
  })

  it('A-2: dirty origin files are not overwritten by worktree edits', async () => {
    const origin = await gitRepo({ 'keep.txt': 'user-dirty', 'ok.txt': 'clean' })
    await writeFile(path.join(origin, 'keep.txt'), 'user-dirty-now', 'utf8')
    const session = await GitWorktreeSession.open(origin)
    expect(session.isolated).toBe(true)
    await session.workspace.writeFile('keep.txt', 'agent-version')
    await session.workspace.writeFile('ok.txt', 'agent-ok')
    const apply = await session.applyToOrigin(['keep.txt', 'ok.txt'])
    expect(apply.conflicts).toContain('keep.txt')
    expect(apply.applied).toContain('ok.txt')
    expect(apply.patchPath).toBeDefined()
    expect(await readFile(path.join(origin, 'keep.txt'), 'utf8')).toBe('user-dirty-now')
    expect(await readFile(path.join(origin, 'ok.txt'), 'utf8')).toBe('agent-ok')
    const patch = await readFile(apply.patchPath!, 'utf8')
    expect(patch).toContain('agent-version')
    expect(patch).toContain('keep.txt')
    const listed = await gitExec(origin, ['worktree', 'list'])
    await session.dispose()
    const after = await gitExec(origin, ['worktree', 'list'])
    expect(listed).toContain(session.worktreeRoot ?? 'codeden-wt-')
    expect(after).not.toContain(session.worktreeRoot ?? 'never')
  })

  it('A-3: verified changes to clean files are copied back', async () => {
    const origin = await gitRepo({ 'pkg.json': '{"v":1}' })
    const session = await GitWorktreeSession.open(origin)
    await session.workspace.writeFile('pkg.json', '{"v":2}')
    const apply = await session.applyToOrigin(['pkg.json'])
    expect(apply.applied).toEqual(['pkg.json'])
    expect(apply.conflicts).toEqual([])
    expect(apply.patchPath).toBeUndefined()
    expect(await readFile(path.join(origin, 'pkg.json'), 'utf8')).toBe('{"v":2}')
    await session.dispose()
  })

  it('A-3b: unchanged files are skipped without being reported as applied', async () => {
    const origin = await gitRepo({ 'same.txt': 'head' })
    const session = await GitWorktreeSession.open(origin)
    await session.workspace.writeFile('same.txt', 'head')
    const apply = await session.applyToOrigin(['same.txt'])
    expect(apply.applied).toEqual([])
    expect(apply.unchanged).toEqual(['same.txt'])
    expect(apply.conflicts).toEqual([])
    expect(apply.patchPath).toBeUndefined()
    await session.dispose()
  })

  it('A-3c: origin deletion during unchanged check is reported as conflict', async () => {
    const origin = await gitRepo({ 'same.txt': 'head' })
    const session = await GitWorktreeSession.open(origin)
    await session.workspace.writeFile('same.txt', 'head')
    await rm(path.join(origin, 'same.txt'))
    const apply = await session.applyToOrigin(['same.txt'])
    expect(apply.applied).toEqual([])
    expect(apply.unchanged).toEqual([])
    expect(apply.conflicts).toEqual(['same.txt'])
    await session.dispose()
  })

  it('A-4: a dirty file the agent also edited is a conflict', async () => {
    const origin = await gitRepo({ 'same.txt': 'head' })
    await writeFile(path.join(origin, 'same.txt'), 'user', 'utf8')
    const session = await GitWorktreeSession.open(origin)
    await session.workspace.writeFile('same.txt', 'agent')
    const apply = await session.applyToOrigin(['same.txt'])
    expect(apply.applied).toEqual([])
    expect(apply.conflicts).toEqual(['same.txt'])
    expect(await readFile(path.join(origin, 'same.txt'), 'utf8')).toBe('user')
    await session.dispose()
  })

  it('A-5: skipping apply leaves the origin unchanged and removes the worktree', async () => {
    const origin = await gitRepo({ 'a.txt': 'keep' })
    const session = await GitWorktreeSession.open(origin)
    expect(session.isolated).toBe(true)
    const worktreeRoot = session.worktreeRoot
    await session.workspace.writeFile('a.txt', 'agent')
    expect(await readFile(path.join(origin, 'a.txt'), 'utf8')).toBe('keep')
    await session.discardPatch()
    await session.dispose()
    expect(await readFile(path.join(origin, 'a.txt'), 'utf8')).toBe('keep')
    await expect(
      readFile(path.join(origin, '.codeden', 'last.patch'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    if (worktreeRoot) {
      const listed = await gitExec(origin, ['worktree', 'list'])
      expect(listed).not.toContain(worktreeRoot)
    }
  })

  it('B-1: rejects write-back paths outside the workspace', async () => {
    const origin = await gitRepo({ 'a.txt': 'keep' })
    const session = await GitWorktreeSession.open(origin)
    await expect(session.applyToOrigin(['../outside.txt'])).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_DENIED',
    })
    await session.dispose()
  })

  it('B-2: rejects symlink write-back paths', async () => {
    const origin = await gitRepo({ 'a.txt': 'keep' })
    const outside = await emptyDir()
    await symlink(outside, path.join(origin, 'linked'))
    const session = await GitWorktreeSession.open(origin)
    await expect(session.applyToOrigin(['linked/secret.txt'])).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_DENIED',
    })
    await session.dispose()
  })

  it('B-3: detects an origin edit made after the session started', async () => {
    const origin = await gitRepo({ 'same.txt': 'head' })
    const session = await GitWorktreeSession.open(origin)
    await writeFile(path.join(origin, 'same.txt'), 'edited-during-run', 'utf8')
    await session.workspace.writeFile('same.txt', 'agent')
    const apply = await session.applyToOrigin(['same.txt'])
    expect(apply.applied).toEqual([])
    expect(apply.conflicts).toEqual(['same.txt'])
    expect(await readFile(path.join(origin, 'same.txt'), 'utf8')).toBe('edited-during-run')
    await session.dispose()
  })

  it('B-8: blocks secrets from conflict patches', async () => {
    const origin = await gitRepo({ 'same.txt': 'head' })
    await writeFile(path.join(origin, 'same.txt'), 'user', 'utf8')
    const security = createSecurityServices({})
    security.registry.register(new ResolvedSecret('sentinel-secret-value'))
    const session = await GitWorktreeSession.open(origin, security)
    await session.workspace.writeFile('same.txt', 'sentinel-secret-value')
    await expect(session.applyToOrigin(['same.txt'])).rejects.toMatchObject({
      code: 'SECRET_LEAK_DETECTED',
    })
    await session.dispose()
  })

  it('B-9: preserves a previous conflict patch when the current run is discarded', async () => {
    const origin = await gitRepo({ 'a.txt': 'keep' })
    await mkdir(path.join(origin, '.codeden'), { recursive: true })
    const patchPath = path.join(origin, '.codeden', 'last.patch')
    await writeFile(patchPath, 'previous patch\n', 'utf8')
    const session = await GitWorktreeSession.open(origin)
    await session.discardPatch()
    expect(await readFile(patchPath, 'utf8')).toBe('previous patch\n')
    await session.dispose()
  })
})

async function emptyDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'codeden-nowt-'))
}

async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-git-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
  await gitExec(root, ['init'])
  await gitExec(root, ['config', 'user.email', 'test@example.com'])
  await gitExec(root, ['config', 'user.name', 'test'])
  await gitExec(root, ['add', '-A'])
  await gitExec(root, ['commit', '-m', 'init'])
  return root
}

async function gitExec(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
  })
  return stdout
}
