import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const databaseName = process.env.CODEDEN_EVAL_DATABASE_NAME ?? 'codeden'
const databaseUser = process.env.CODEDEN_EVAL_DATABASE_USER ?? 'postgres'
const databaseContainer = process.env.CODEDEN_EVAL_DATABASE_CONTAINER ?? 'codeden-postgres-alt'
const databaseImage = process.env.CODEDEN_EVAL_DATABASE_IMAGE ?? 'postgres:16'
const configuredDatabasePort = process.env.CODEDEN_EVAL_DATABASE_PORT
  ? Number(process.env.CODEDEN_EVAL_DATABASE_PORT)
  : undefined
const configuredWebPort = process.env.CODEDEN_EVAL_WEB_PORT
  ? Number(process.env.CODEDEN_EVAL_WEB_PORT)
  : 3210
const env = {
  ...process.env,
  CODEDEN_EVAL_ROOT: process.env.CODEDEN_EVAL_ROOT ?? root,
  CODEDEN_EVAL_DATABASE_URL: process.env.CODEDEN_EVAL_DATABASE_URL ?? '',
  CODEDEN_EVAL_REAL_MODELS: process.env.CODEDEN_EVAL_REAL_MODELS ?? '1',
}
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const execFileAsync = promisify(execFile)
const children = []
let shuttingDown = false

function start(args, name, processEnv = env) {
  const child = spawn(command, args, { cwd: root, env: processEnv, stdio: 'inherit' })
  children.push(child)
  child.on('exit', (code, signal) => {
    if (!shuttingDown && (code ?? 0) !== 0) {
      console.error(`[${name}] 已退出：${signal ?? code}`)
      shutdown(code ?? 1)
    }
  })
}

function shutdown(code = 0) {
  if (shuttingDown) {
return
}
  shuttingDown = true
  for (const child of children) {
child.kill('SIGTERM')
}
  setTimeout(() => process.exit(code), 500).unref()
}

async function runChecked(file, args) {
  await execFileAsync(file, args, { cwd: root, env })
}

async function runOutput(file, args) {
  const result = await execFileAsync(file, args, { cwd: root, env })
  return result.stdout.trim()
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

async function findAvailablePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await isPortAvailable(port)) {
return port
}
  }
  throw new Error('没有找到可用的本地数据库端口。')
}

async function containerExists(name) {
  try {
    await runChecked('docker', ['inspect', name])
    return true
  } catch {
    return false
  }
}

async function containerHostPort(name) {
  const output = await runOutput('docker', ['port', name, '5432/tcp'])
  const match = output.match(/:(\d+)$/m)
  if (!match) {
throw new Error(`容器 ${name} 没有暴露 PostgreSQL 端口。`)
}
  return Number(match[1])
}

async function ensureLocalDatabase() {
  if (process.env.CODEDEN_EVAL_DATABASE_URL) {
return
}
  try {
    await runChecked('docker', ['info'])
  } catch {
    if (process.platform !== 'darwin') {
      throw new Error('Docker 未运行，请先启动 Docker，再重试。')
    }
    try {
      await runChecked('colima', ['start'])
    } catch {
      throw new Error('Docker/Colima 未运行，无法自动启动本地 PostgreSQL。')
    }
  }

  // 5432 经常被本机 PostgreSQL、SSH 转发或其他容器占用；评测平台使用独立端口。
  const defaultPort = configuredDatabasePort ?? 55432
  let containerName = databaseContainer
  let hostPort
  if (await containerExists(containerName)) {
    try {
      hostPort = await containerHostPort(containerName)
      await runChecked('docker', ['start', containerName]).catch(() => undefined)
    } catch {
      // 旧容器可能在端口绑定失败后残留，改用新容器避免破坏用户数据。
      hostPort = await findAvailablePort(defaultPort)
      containerName = `codeden-postgres-${hostPort}`
      if (await containerExists(containerName)) {
        hostPort = await findAvailablePort(hostPort + 1)
        containerName = `codeden-postgres-${hostPort}`
      }
      await createPostgresContainer(containerName, hostPort)
    }
  } else {
    hostPort = await findAvailablePort(defaultPort)
    await createPostgresContainer(containerName, hostPort)
  }
  env.CODEDEN_EVAL_DATABASE_URL = buildDatabaseUrl(hostPort)

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await runChecked('docker', [
        'exec',
        containerName,
        'pg_isready',
        '-U',
        databaseUser,
        '-d',
        databaseName,
      ])
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error('PostgreSQL 启动超时，请检查数据库容器日志。')
}

async function createPostgresContainer(name, hostPort) {
  await runChecked('docker', [
    'run',
    '--name',
    name,
    '-e',
    `POSTGRES_DB=${databaseName}`,
    '-e',
    `POSTGRES_USER=${databaseUser}`,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-p',
    `127.0.0.1:${hostPort}:5432`,
    '-d',
    databaseImage,
  ])
}

function buildDatabaseUrl(hostPort) {
  const user = encodeURIComponent(databaseUser)
  const database = encodeURIComponent(databaseName)
  return `postgres://${user}@127.0.0.1:${hostPort}/${database}`
}

async function main() {
  if (!env.DEEPSEEK_API_KEY && !env.OPENAI_API_KEY && !env.XAI_API_KEY && !env.ANTHROPIC_API_KEY) {
    throw new Error('未配置真实模型 API Key，请先 export DEEPSEEK_API_KEY=sk-...')
  }
  await ensureLocalDatabase()
  const migration = spawn(command, ['--filter', '@codeden/eval-platform', 'migrate'], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  migration.on('exit', (code) => {
    if (code !== 0) {
return shutdown(code ?? 1)
}
    start(['--filter', '@codeden/eval-platform', 'worker'], 'eval-worker')
    void startWeb().catch((error) => {
      console.error(`[eval-web] ${error instanceof Error ? error.message : String(error)}`)
      shutdown(1)
    })
  })
}

async function startWeb() {
  const webPort = await findAvailablePort(configuredWebPort)
  env.CODEDEN_EVAL_ORIGIN = `http://127.0.0.1:${webPort}`
  console.log(`[eval-web] http://127.0.0.1:${webPort}`)
  const sourceConditions = '--conditions=codeden-source'
  const webEnv = {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, sourceConditions].filter(Boolean).join(' '),
  }
  start(
    [
      '--dir',
      'apps/eval-platform/web',
      'exec',
      'next',
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    'eval-web',
    webEnv,
  )
}

process.once('SIGINT', () => shutdown())
process.once('SIGTERM', () => shutdown())
main().catch((error) => {
  console.error(`[eval-platform] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
