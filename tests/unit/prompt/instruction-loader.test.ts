import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { InstructionLoader } from '../../../src/runtime/prompt/instruction-loader.js'

describe('InstructionLoader', () => {
  it('loads supported instruction files in a stable order', async () => {
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
})
