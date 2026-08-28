import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodeDenError } from '../../src/core/errors/codeden-error.js'
import { createFileDiff } from '../../src/runtime/workspace/patch-diff.js'

describe('测试套件：createFileDiff', () => {
  it('验证：returns an empty diff for identical files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codeden-diff-'))
    const file = path.join(root, 'file.txt')
    await writeFile(file, 'same\n')
    await expect(createFileDiff('file.txt', file, file)).resolves.toBe('')
  })

  it('验证：rejects binary conflicts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codeden-diff-'))
    const from = path.join(root, 'from.bin')
    const to = path.join(root, 'to.bin')
    await writeFile(from, Buffer.from([0, 1]))
    await writeFile(to, Buffer.from([0, 2]))
    await expect(createFileDiff('file.bin', from, to)).rejects.toBeInstanceOf(CodeDenError)
  })
})
