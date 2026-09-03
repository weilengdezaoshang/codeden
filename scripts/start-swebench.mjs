import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const children = []

function start(command, args, name) {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' })
  children.push(child)
  child.on('exit', (code, signal) => {
    if (!shuttingDown && (code ?? 0) !== 0) {
      console.error(`[${name}] 已退出：${signal ?? code}`)
      shutdown(code ?? 1)
    }
  })
}

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  for (const child of children) {
    child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 500)
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('未配置 DEEPSEEK_API_KEY，请先 export DEEPSEEK_API_KEY=sk-...')
  process.exit(1)
}

start(
  process.platform === 'win32' ? 'node.exe' : 'node',
  ['scripts/swebench-server.mjs'],
  'swebench-web',
)

if (process.env.CODEDEN_EVAL_DATABASE_URL) {
  const workerCount = Number(process.env.CODEDEN_EVAL_WORKERS ?? '1')
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 32) {
    console.error('CODEDEN_EVAL_WORKERS 必须是 1 到 32 之间的整数')
    process.exit(1)
  }
  for (let index = 0; index < workerCount; index += 1) {
    start(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--filter', '@codeden/eval-platform', 'worker'],
      `eval-worker-${index + 1}`,
    )
  }
  console.log(`[eval-worker] 已启动 ${workerCount} 个 Worker`)
} else {
  console.log('[eval-worker] 未配置 CODEDEN_EVAL_DATABASE_URL，页面 API 使用本地 Job 执行模式')
}

process.once('SIGINT', () => shutdown())
process.once('SIGTERM', () => shutdown())
