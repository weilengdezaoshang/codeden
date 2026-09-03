import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const repository = path.resolve('.')
const units = [
  'packages/core',
  'packages/agent-runtime',
  'packages/telemetry',
  'packages/eval-engine',
  'apps/agent',
  'apps/eval-platform',
]

/** 只复制受测源码与构建配置；不带入已有 dist、缓存或用户配置。 */
export async function copyBuildWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-build-test-'))
  for (const file of [
    'package.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'pnpm-lock.yaml',
    'scripts',
    'src',
  ]) {
    await cp(path.join(repository, file), path.join(root, file), { recursive: true })
  }
  await mkdir(path.join(root, 'node_modules/@codeden'), { recursive: true })
  for (const name of ['typescript', '@types', 'openai', 'yaml', 'zod']) {
    await symlink(
      path.join(repository, 'node_modules', name),
      path.join(root, 'node_modules', name),
      'dir',
    )
  }
  for (const unit of units) {
    const target = path.join(root, unit)
    await symlink(target, path.join(root, 'node_modules/@codeden', path.basename(unit)), 'dir')
    await mkdir(target, { recursive: true })
    for (const file of ['package.json', 'tsconfig.json', 'src']) {
      await cp(path.join(repository, unit, file), path.join(target, file), { recursive: true })
    }
    const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
    const internal = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith('@codeden/'),
    )
    if (internal.length) {
      await mkdir(path.join(target, 'node_modules/@codeden'), { recursive: true })
    }
    for (const name of internal) {
      await symlink(
        path.join(root, 'packages', name.split('/')[1]!),
        path.join(target, 'node_modules', name),
        'dir',
      )
    }
    const external = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
      (name) => !name.startsWith('@codeden/'),
    )
    for (const name of external) {
      const link = path.join(target, 'node_modules', name)
      await mkdir(path.dirname(link), { recursive: true })
      await symlink(path.join(repository, unit, 'node_modules', name), link, 'dir')
    }
  }
  return root
}

/** 执行清单中的实际构建配方，不让 pnpm 自动安装检查改变工作区或访问网络。 */
export async function runBuildScript(root: string, unit = '.', script = 'build') {
  const cwd = path.resolve(root, unit)
  const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'))
  for (const command of (manifest.scripts[script] as string).split(' && ')) {
    const [program, ...args] = command.split(' ')
    if (program !== 'node' && program !== 'tsc') {
      throw new Error(`未支持的构建命令：${program}`)
    }
    await execute(
      process.execPath,
      program === 'tsc'
        ? [path.join(repository, 'node_modules/typescript/bin/tsc'), ...args]
        : args,
      {
        cwd,
        timeout: 30_000,
        maxBuffer: 2_000_000,
      },
    )
  }
}

export async function runBuiltEval(root: string) {
  return execute(
    process.execPath,
    [
      'apps/eval-platform/dist/cli/eval-command.js',
      '--case',
      path.join(repository, 'evals/cases/regression/update-package-version.yaml'),
      '--results-dir',
      path.join(root, 'results'),
      '--release-evidence',
    ],
    { cwd: root, timeout: 20_000 },
  )
}
