import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  diagnoseInstructionConflicts,
  InstructionLoader,
} from '../../../packages/agent-runtime/src/prompt/instruction-loader.js'

describe('测试套件：InstructionLoader', () => {
  it('验证：loads supported instruction files in a stable order', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-instructions-'))
    try {
      await writeFile(path.join(root, 'AGENTS.md'), 'project rules')
      await writeFile(path.join(root, 'SOUL.md'), 'be concise')
      const result = await new InstructionLoader().load(root)
      expect(result.map((item) => item.kind)).toEqual(['personality', 'project'])
      expect(result.map((item) => item.content)).toEqual(['be concise', 'project rules'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：loads project-specific instructions from .codeden', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-instructions-'))
    try {
      await mkdir(path.join(root, '.codeden'))
      await writeFile(path.join(root, '.codeden', 'SOUL.md'), 'project personality')
      const [instruction] = await new InstructionLoader().load(root)
      expect(instruction?.file).toBe(path.join(root, '.codeden', 'SOUL.md'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：诊断同一层级的多个指令来源并选择最后加载项', () => {
    const conflicts = diagnoseInstructionConflicts([
      { file: '/repo/AGENTS.md', content: 'a', kind: 'project', scope: 'project' },
      { file: '/repo/CLAUDE.md', content: 'b', kind: 'project', scope: 'project' },
      { file: '/home/.codeden/SOUL.md', content: 'c', kind: 'personality', scope: 'user' },
      { file: '/repo/SOUL.md', content: 'd', kind: 'personality', scope: 'project' },
    ])
    expect(conflicts).toEqual([
      {
        kind: 'project',
        scope: 'project',
        selected: '/repo/CLAUDE.md',
        candidates: ['/repo/AGENTS.md', '/repo/CLAUDE.md'],
      },
    ])
  })

  it('验证：加载用户级人格并让项目指令保持更高优先级', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-instructions-'))
    const home = await mkdtemp(path.join(tmpdir(), 'codeden-home-'))
    try {
      await mkdir(path.join(root, '.git'))
      await mkdir(path.join(home, '.codeden'))
      await writeFile(path.join(home, '.codeden', 'SOUL.md'), 'user personality')
      await writeFile(path.join(root, 'SOUL.md'), 'project personality')
      const result = await new InstructionLoader().loadHierarchy(root, {
        includeUser: true,
        userHome: home,
      })
      expect(result.map((item) => item.content)).toEqual([
        'user personality',
        'project personality',
      ])
      expect(result.map((item) => item.scope)).toEqual(['user', 'project'])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('验证：loads parent instructions before child instructions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-instructions-'))
    const child = path.join(root, 'packages', 'app')
    try {
      await mkdir(path.join(root, 'packages'), { recursive: true })
      await mkdir(child, { recursive: true })
      await mkdir(path.join(root, '.git'))
      await writeFile(path.join(root, 'AGENTS.md'), 'root rules')
      await writeFile(path.join(child, 'AGENTS.md'), 'child rules')
      const result = await new InstructionLoader().loadHierarchy(child)
      expect(result.slice(-2).map((item) => item.content)).toEqual(['root rules', 'child rules'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：truncates oversized instruction files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-instructions-'))
    try {
      await writeFile(path.join(root, 'SOUL.md'), '0123456789')
      const [instruction] = await new InstructionLoader(5).load(root)
      expect(instruction?.content).toBe('01234\n[Instruction truncated]')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：rejects an invalid maximum length', () => {
    expect(() => new InstructionLoader(0)).toThrow('positive integer')
    expect(() => new InstructionLoader(Number.NaN)).toThrow('positive integer')
  })

  it('验证：keeps child rules when the hierarchy exceeds the total budget', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-instructions-'))
    const child = path.join(root, 'child')
    try {
      await mkdir(child, { recursive: true })
      await mkdir(path.join(root, '.git'))
      await writeFile(path.join(root, 'AGENTS.md'), 'a'.repeat(20))
      await writeFile(path.join(child, 'AGENTS.md'), 'child rules')
      const result = await new InstructionLoader(
        20_000,
        (file, encoding) => readFile(file, encoding),
        11,
      ).loadHierarchy(child)
      expect(result.at(-1)?.content).toBe('child rules')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：surfaces a file read failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-instructions-'))
    try {
      await writeFile(path.join(root, 'SOUL.md'), 'personality')
      const loader = new InstructionLoader(20_000, async (file: string) => {
        if (file.endsWith('SOUL.md')) {
          throw new Error('permission denied')
        }
        return 'fallback'
      })
      await expect(loader.load(root)).rejects.toThrow('permission denied')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：surfaces non-missing file errors', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-instructions-'))
    try {
      await writeFile(path.join(root, 'SOUL.md'), 'personality')
      const loader = new InstructionLoader(20_000, async () => {
        const error = new Error('permission denied') as Error & { code: string }
        error.code = 'EACCES'
        throw error
      })
      await expect(loader.load(root)).rejects.toThrow('permission denied')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
