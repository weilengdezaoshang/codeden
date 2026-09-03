import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const packageRoots = [
  'packages/core',
  'packages/agent-runtime',
  'packages/telemetry',
  'packages/eval-engine',
  'apps/agent',
  'apps/eval-platform',
]

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name)
        return entry.isDirectory() ? sources(target) : target.endsWith('.ts') ? [target] : []
      }),
    )
  ).flat()
}

it('Agent 执行、配置与采集模块不得反向依赖评测或晋级模块', async () => {
  const violations: string[] = []
  for (const area of [
    'packages/agent-runtime',
    'packages/core',
    'packages/telemetry',
    'apps/agent',
  ]) {
    const manifest = JSON.parse(await readFile(path.join(area, 'package.json'), 'utf8'))
    expect(Object.keys(manifest.dependencies ?? {}).filter((name) => /eval/.test(name))).toEqual([])
    for (const file of await sources(path.resolve(area, 'src'))) {
      const imports = ts.preProcessFile(await readFile(file, 'utf8')).importedFiles
      for (const dependency of imports) {
        const target = path.resolve(path.dirname(file), dependency.fileName)
        if (
          /(@codeden\/(eval-engine|eval-platform)|\/(eval-engine|eval-platform)\/)/.test(
            dependency.fileName + target,
          )
        ) {
          violations.push(`${path.relative(process.cwd(), file)} -> ${dependency.fileName}`)
        }
      }
    }
  }
  expect(violations).toEqual([])
})

it('跨包调用只通过已声明的包依赖且公共库不得依赖应用', async () => {
  const violations: string[] = []
  for (const root of packageRoots) {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const declared = new Set(Object.keys(manifest.dependencies ?? {}))
    if (root.startsWith('packages/')) {
      expect(
        [...declared].filter((name) => ['@codeden/agent', '@codeden/eval-platform'].includes(name)),
      ).toEqual([])
    }
    if (root === 'packages/core' || root === 'packages/telemetry') {
      expect(
        [...declared].filter((name) => name.startsWith('@codeden/') && name !== '@codeden/core'),
      ).toEqual([])
    }
    for (const file of await sources(path.resolve(root, 'src'))) {
      for (const dependency of ts.preProcessFile(await readFile(file, 'utf8')).importedFiles) {
        const name = dependency.fileName
        const external = name.startsWith('@')
          ? name.split('/').slice(0, 2).join('/')
          : name.split('/')[0]!
        if (name.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), name)
          if (!resolved.startsWith(`${path.resolve(root, 'src')}/`)) {
            violations.push(`${file}: 跨包相对导入 ${name}`)
          }
        } else if (!name.startsWith('node:') && !declared.has(external)) {
          violations.push(`${file}: 未声明依赖 ${name}`)
        }
      }
    }
  }
  expect(violations).toEqual([])
})
