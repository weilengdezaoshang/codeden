import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../../../src/runtime/memory/memory-store.js'

describe('测试套件：MemoryStore', () => {
  it('验证：持久化并合并用户与项目记忆', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-memory-'))
    const home = await mkdtemp(path.join(tmpdir(), 'codeden-home-'))
    try {
      const store = new MemoryStore({ projectRoot: root, userHome: home })
      await store.add('项目使用 pnpm', { scope: 'project', kind: 'preference' })
      await store.add('用户偏好中文回复', { scope: 'user', kind: 'preference' })
      const entries = await store.list()
      expect(entries).toHaveLength(2)
      expect(entries.map((entry) => entry.content)).toEqual(
        expect.arrayContaining(['用户偏好中文回复', '项目使用 pnpm']),
      )
      expect(await readFile(path.join(root, '.codeden', 'memory.json'), 'utf8')).toContain(
        '项目使用 pnpm',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('验证：拒绝空内容、超长内容和疑似密钥', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-memory-'))
    try {
      const store = new MemoryStore({ projectRoot: root, maxContentChars: 8 })
      await expect(store.add('')).rejects.toThrow('must not be empty')
      await expect(store.add('123456789')).rejects.toThrow('exceeds')
      await expect(
        new MemoryStore({ projectRoot: root, maxContentChars: 100 }).add('sk-test-secret'),
      ).rejects.toThrow('secret')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
