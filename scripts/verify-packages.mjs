import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'codeden-packaging-'))
try {
  // 在仅含构建产物的副本中安装注入依赖，既不污染开发安装，也不保留仓库软链接。
  const snapshot = path.join(temporary, 'workspace')
  await mkdir(snapshot)
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    await cp(path.join(root, file), path.join(snapshot, file))
  }
  for (const area of ['apps', 'packages']) {
    for (const name of await readdir(path.join(root, area))) {
      const destination = path.join(snapshot, area, name)
      await mkdir(destination, { recursive: true })
      for (const file of await readdir(path.join(root, area, name))) {
        if (['dist', 'bin', 'package.json'].includes(file)) {
          await cp(path.join(root, area, name, file), path.join(destination, file), {
            recursive: true,
          })
        }
      }
    }
  }
  execFileSync(
    'pnpm',
    [
      'install',
      '--prod',
      '--offline',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      '--config.inject-workspace-packages=true',
    ],
    { cwd: snapshot, encoding: 'utf8', stdio: 'pipe' },
  )
  for (const name of ['agent', 'eval-platform']) {
    const target = path.join(temporary, name)
    execFileSync(
      'pnpm',
      [
        '--filter',
        `@codeden/${name}`,
        'deploy',
        '--prod',
        '--offline',
        '--ignore-scripts',
        '--config.inject-workspace-packages=true',
        target,
      ],
      { cwd: snapshot, stdio: 'pipe', encoding: 'utf8' },
    )
    const installed = path.join(target, 'node_modules', '@codeden')
    for (const name of await readdir(installed)) {
      assert(
        (await realpath(path.join(installed, name))).startsWith(`${await realpath(target)}/`),
        '部署依赖不得指向源仓库或工作区副本',
      )
    }
    if (name === 'agent') {
      const modules = await readdir(path.join(target, 'node_modules', '@codeden'))
      assert(!modules.some((name) => name.includes('eval')), 'Agent 部署不得携带评测依赖')
      const output = execFileSync(process.execPath, ['bin/codeden.mjs', '--help'], {
        cwd: target,
        encoding: 'utf8',
      })
      assert.equal(output.split('Usage:').length - 1, 1, '入口不得重复启动')
    } else {
      // 从仓库外启动、使用构建产物指纹跑完整评测，证明没有依赖源码路径。
      const output = execFileSync(
        process.execPath,
        [
          'bin/codeden-eval.mjs',
          '--case',
          path.join(root, 'evals/cases/regression/update-package-version.yaml'),
          '--results-dir',
          path.join(temporary, 'results'),
          '--release-evidence',
        ],
        { cwd: target, encoding: 'utf8' },
      )
      assert.match(output, /Results:/)
    }
    console.log(`${name}: 独立部署验证通过`)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
