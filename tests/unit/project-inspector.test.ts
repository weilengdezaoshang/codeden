import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectInspector } from '../../packages/agent-runtime/src/project/project-inspector.js'

describe('测试套件：ProjectInspector', () => {
  it('验证：records package manager and real scripts only', async () => {
    const root = await mkdirp()
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'sample',
        packageManager: 'pnpm@11.21.0',
        scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', build: 'tsc' },
      }),
      'utf8',
    )
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
    const facts = await new ProjectInspector().inspect(root)
    expect(facts.hasPackageJson).toBe(true)
    expect(facts.packageManager).toBe('pnpm')
    expect(facts.scripts.test).toBe('vitest run')
    expect(facts.scripts.lint).toBeUndefined()
  })

  it('验证：does not invent scripts when package.json is missing', async () => {
    const facts = await new ProjectInspector().inspect(await mkdirp())
    expect(facts.hasPackageJson).toBe(false)
    expect(facts.scripts).toEqual({})
    expect(facts.packageManager).toBe('unknown')
  })
})

async function mkdirp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'codeden-facts-'))
}
