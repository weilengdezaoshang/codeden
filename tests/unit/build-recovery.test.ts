import { createHash } from 'node:crypto'
import { access, appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyBuildWorkspace, runBuildScript, runBuiltEval } from '../helpers/build-workspace.js'

let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('构建产物恢复与独立评测构建', { timeout: 40_000 }, () => {
  it('根构建会恢复兼容入口并重新生成损坏的指纹文件', async () => {
    root = await copyBuildWorkspace()
    await runBuildScript(root)
    await rm(path.join(root, 'dist/cli/codeden.js'))
    const manifest = path.join(root, 'packages/eval-engine/dist/build-provenance.json')
    await writeFile(manifest, '{损坏的文件')
    await runBuildScript(root)
    await expect(access(path.join(root, 'dist/cli/codeden.js'))).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(manifest, 'utf8')).schemaVersion).toBe(1)
    await rm(path.join(root, 'pnpm-lock.yaml'))
    await expect(runBuildScript(root)).rejects.toBeDefined()
    await expect(access(manifest)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('保留缓存并删除依赖目录或单个输出文件后仍能重新构建 Agent', async () => {
    root = await copyBuildWorkspace()
    await runBuildScript(root, '.', 'build:agent')
    await access(path.join(root, 'packages/core/.cache/build.tsbuildinfo'))
    await rm(path.join(root, 'packages/core/dist'), { recursive: true })
    await rm(path.join(root, 'apps/agent/dist/codeden.js'))
    await runBuildScript(root, '.', 'build:agent')
    await expect(access(path.join(root, 'packages/core/dist/metrics.js'))).resolves.toBeUndefined()
    await expect(access(path.join(root, 'apps/agent/dist/codeden.js'))).resolves.toBeUndefined()
    await expect(access(path.join(root, 'packages/eval-engine/dist'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('公共包自身构建也会恢复缺失产物', async () => {
    root = await copyBuildWorkspace()
    await runBuildScript(root, 'packages/core')
    await rm(path.join(root, 'packages/core/dist/metrics.js'))
    await runBuildScript(root, 'packages/core')
    await expect(access(path.join(root, 'packages/core/dist/metrics.js'))).resolves.toBeUndefined()
  })

  it('干净工作区单独构建评测应用即可生成发布证据并运行评测', async () => {
    root = await copyBuildWorkspace()
    await runBuildScript(root, 'apps/eval-platform')
    const lock = await readFile(path.join(root, 'pnpm-lock.yaml'))
    const manifest = JSON.parse(
      await readFile(path.join(root, 'packages/eval-engine/dist/build-provenance.json'), 'utf8'),
    )
    expect(manifest).toEqual({
      schemaVersion: 1,
      lockDigest: createHash('sha256').update(lock).digest('hex'),
    })
    await expect(runBuiltEval(root)).resolves.toMatchObject({
      stdout: expect.stringContaining('Results:'),
    })
    await expect(access(path.join(root, 'apps/agent/dist'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('单独重建评测引擎会刷新锁文件指纹且构建失败不保留旧凭证', async () => {
    root = await copyBuildWorkspace()
    await runBuildScript(root, 'packages/eval-engine')
    const manifestPath = path.join(root, 'packages/eval-engine/dist/build-provenance.json')
    const first = JSON.parse(await readFile(manifestPath, 'utf8'))
    await appendFile(path.join(root, 'pnpm-lock.yaml'), '\n# 构建测试\n')
    await runBuildScript(root, 'packages/eval-engine')
    const second = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(second.lockDigest).not.toBe(first.lockDigest)
    await writeFile(
      path.join(root, 'packages/eval-engine/src/build-error.ts'),
      'const broken: string = 1\nexport { broken }\n',
    )
    await expect(runBuildScript(root, 'packages/eval-engine')).rejects.toBeDefined()
    await expect(access(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
