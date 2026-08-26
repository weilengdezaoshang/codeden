import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyChange,
  digestFile,
  type FileDigest,
} from '../../src/runtime/workspace/apply-plan.js'

const file = (sha256: string, overrides: Partial<FileDigest> = {}): FileDigest => ({
  path: 'a.txt',
  exists: true,
  type: 'file',
  mode: 0o644,
  size: sha256.length,
  sha256,
  ...overrides,
})

describe('classifyChange', () => {
  it.each([
    ['unchanged', file('a'), file('a'), file('a')],
    ['modified', file('a'), file('a'), file('b')],
    ['conflict', file('a'), file('b'), file('c')],
    ['added', { path: 'a.txt', exists: false }, { path: 'a.txt', exists: false }, file('a')],
    ['deleted', file('a'), file('a'), { path: 'a.txt', exists: false }],
  ] as const)('%s', (expected, base, current, candidate) => {
    expect(classifyChange(base, current, candidate)).toBe(expected)
  })

  it('detects mode and type changes as modifications', () => {
    expect(classifyChange(file('a'), file('a'), file('a', { mode: 0o755 }))).toBe('modified')
    expect(
      classifyChange(file('a'), file('a'), file('a', { type: 'symlink', linkTarget: 'x' })),
    ).toBe('modified')
  })

  it('does not treat different paths as the same digest', () => {
    expect(classifyChange(file('a'), { ...file('a'), path: 'b.txt' }, file('a'))).toBe('conflict')
  })
})

describe('digestFile', () => {
  it('computes stable content and mode digest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-digest-'))
    try {
      const file = path.join(root, 'a.txt')
      await writeFile(file, 'hello')
      const digest = await digestFile(file, 'a.txt')
      expect(digest).toMatchObject({
        path: 'a.txt',
        exists: true,
        type: 'file',
        size: 5,
        mode: 0o644,
      })
      expect(digest.sha256).toHaveLength(64)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('represents missing files and symlink targets without following links', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-digest-'))
    try {
      expect(await digestFile(path.join(root, 'missing'), 'missing')).toEqual({
        path: 'missing',
        exists: false,
      })
      const target = path.join(root, 'target')
      const link = path.join(root, 'link')
      await writeFile(target, 'secret')
      await symlink('target', link)
      expect(await digestFile(link, 'link')).toMatchObject({
        type: 'symlink',
        linkTarget: 'target',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
