import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.CODEDEN_SWEBENCH_PORT ?? 8769)
const dataset = path.join(root, '.codex/datasets/swebench-lite-test.jsonl')
const reports = path.join(root, '.codex/swebench-reports')
const jobs = new Map()

async function checksum(file) {
  const hash = createHash('sha256')
  hash.update(await readFile(file))
  return hash.digest('hex')
}

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function runJob(request, response) {
  if (!existsSync(dataset)) {
    return json(response, 503, { error: 'SWE-bench Lite 数据集不存在。' })
  }
  const body = await new Promise((resolve, reject) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 8192) {
        reject(new Error('请求过大'))
      }
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        reject(new Error('JSON 无效'))
      }
    })
    request.on('error', reject)
  }).catch((error) => ({ error: error.message }))
  if (body.error) {
    return json(response, 400, body)
  }
  const limit = Math.min(20, Math.max(1, Number(body.limit ?? 1)))
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const sha256 = await checksum(dataset)
  const args = [
    'eval',
    '--benchmark',
    'swebench-lite',
    '--dataset',
    dataset,
    '--limit',
    String(limit),
    '--version',
    'SWE-bench_Lite-test',
    '--license',
    'mit',
    '--sha256',
    sha256,
    '--test-command',
    'pytest',
    '--allow-host-verification',
    '--model',
    process.env.CODEDEN_MODEL ?? 'deepseek',
    '--results-dir',
    path.join(reports, id),
  ]
  const child = spawn('pnpm', args, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const job = { id, status: 'running', limit, output: '', error: '' }
  jobs.set(id, job)
  child.stdout.on('data', (chunk) => {
    job.output = `${job.output}${chunk}`.slice(-12000)
  })
  child.stderr.on('data', (chunk) => {
    job.error = `${job.error}${chunk}`.slice(-12000)
  })
  child.on('close', (code) => {
    job.status = code === 0 ? 'completed' : 'failed'
    job.exitCode = code
  })
  json(response, 202, job)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`)
    if (url.pathname === '/api/swebench/run' && request.method === 'POST') {
      return await runJob(request, response)
    }
    if (url.pathname.startsWith('/api/swebench/jobs/') && request.method === 'GET') {
      const job = jobs.get(url.pathname.split('/').pop())
      return job ? json(response, 200, job) : json(response, 404, { error: 'Job 不存在。' })
    }
    const requested = url.pathname === '/' ? 'swebench-interactive.html' : url.pathname.slice(1)
    const file = path.resolve(root, 'docs/prd', requested)
    if (!file.startsWith(path.join(root, 'docs/prd')) || !existsSync(file)) {
      return response.end('Not found', 'utf8')
    }
    response.writeHead(200, {
      'content-type': file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : file.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/javascript; charset=utf-8',
    })
    createReadStream(file).pipe(response)
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : '服务失败' })
  }
})

await mkdir(reports, { recursive: true })
server.listen(port, '127.0.0.1', () =>
  console.log(`SWE-bench 页面：http://127.0.0.1:${port}/swebench-interactive.html`),
)
