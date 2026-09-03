import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const scanner = path.resolve('scripts/scan-secrets.mjs')

it('迁移后尚未暂存的中文及空格路径文件也必须参与密钥扫描', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codeden-secret-scan-'))
  try {
    await execute('git', ['init', '-q', directory])
    await writeFile(
      path.join(directory, '中文 路径.ts'),
      `const value = '${'sk' + '-'}${'a'.repeat(20)}'`,
    )
    await expect(execute(process.execPath, [scanner], { cwd: directory })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('中文 路径.ts'),
    })
    await writeFile(path.join(directory, '中文 路径.ts'), 'export const value = 1')
    await expect(execute(process.execPath, [scanner], { cwd: directory })).resolves.toMatchObject({
      stdout: expect.stringContaining('Secret scan passed (1 files)'),
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
