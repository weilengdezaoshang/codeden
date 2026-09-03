import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { invalidateBuildProvenance, stampBuildProvenance } from './stamp-build.mjs'

const [target = '.', ...flags] = process.argv.slice(2)
if (flags.some((flag) => flag !== '--eval-evidence')) {
  throw new Error('用法：node scripts/build.mjs <tsconfig 或项目目录> [--eval-evidence]')
}
const withEvidence = flags.includes('--eval-evidence')
if (withEvidence) {
  // 编译或后续指纹写入失败时，不能留下看似可用的旧构建凭证。
  await invalidateBuildProvenance()
}

// tsc -b 只检查增量缓存，未必检查每个输出文件；显式构建重发所有依赖产物。
const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const result = spawnSync(process.execPath, [compiler, '-b', target, '--force'], {
  stdio: 'inherit',
})
if (result.error) {
  throw result.error
}
process.exitCode = result.status ?? 1
if (process.exitCode === 0 && withEvidence) {
  await stampBuildProvenance()
}
