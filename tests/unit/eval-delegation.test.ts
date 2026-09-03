import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

let directory: string | undefined
let parent: ChildProcess | undefined
let captured = ''
let closed = false

async function start(mode: string, args: string[] = []) {
  directory = await mkdtemp(path.join(tmpdir(), 'codeden-eval-delegate-'))
  if (mode !== 'missing') {
    const executable = path.join(directory, 'codeden-eval')
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = ${JSON.stringify(mode)};
fs.writeFileSync(${JSON.stringify(path.join(directory, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
if (mode === 'exit') process.exit(7);
if (mode === 'self-signal') process.kill(process.pid, 'SIGTERM');
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); process.on('SIGHUP',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], {stdio:['ignore','pipe','ignore']});
for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal, () => {
  fs.appendFileSync(${JSON.stringify(path.join(directory, 'signals'))}, signal+'\\n');
  if (mode === 'graceful') process.exit(0);
});
grandchild.stdout.once('data', () => fs.writeFileSync(${JSON.stringify(path.join(directory, 'pids.json'))}, JSON.stringify([process.pid,grandchild.pid])));
setInterval(()=>{},1000);
`,
    )
    await chmod(executable, mode === 'permission-denied' ? 0o600 : 0o700)
  }
  const moduleUrl = pathToFileURL(path.resolve('apps/agent/src/eval-delegation.ts')).href
  captured = ''
  closed = false
  parent = spawn(
    process.execPath,
    [
      '--conditions=codeden-source',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { delegateEvaluation } from ${JSON.stringify(moduleUrl)};
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    const before = signals.map(signal => process.listenerCount(signal));
    const code = await delegateEvaluation(${JSON.stringify(args)});
    console.log(JSON.stringify({ code, before, after: signals.map(signal => process.listenerCount(signal)) }));
    process.exitCode = code;
  `,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, PATH: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  )
  parent.stdout?.on('data', (chunk) => {
    captured += String(chunk)
  })
  parent.stderr?.on('data', (chunk) => {
    captured += String(chunk)
  })
  parent.once('close', () => {
    closed = true
  })
  return parent
}

async function waitReady(): Promise<number[]> {
  let pids: number[] = []
  await expect
    .poll(
      async () => {
        pids = JSON.parse(await readFile(path.join(directory!, 'pids.json'), 'utf8'))
        return pids.length
      },
      { timeout: 8_000 },
    )
    .toBe(2)
  return pids
}

async function waitExit(code: number) {
  await expect.poll(() => closed, { timeout: 8_000 }).toBe(true)
  expect(parent?.exitCode ?? parent?.signalCode).toBe(code)
  const report = JSON.parse(captured.split('\n').find((line) => line.startsWith('{"code":'))!)
  expect(report.after).toEqual(report.before)
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  // 失败时也只清理本测试创建且记录下来的进程，不遗留常驻子进程。
  if (directory) {
    const pids = await readFile(path.join(directory, 'pids.json'), 'utf8').then(
      (text) => JSON.parse(text) as number[],
      () => [],
    )
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已结束 */
      }
    }
  }
  if (parent && parent.exitCode === null && parent.signalCode === null) {
    const exited = new Promise<void>((resolve) => parent!.once('exit', () => resolve()))
    parent.kill('SIGKILL')
    await exited
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
  directory = undefined
  parent = undefined
})

describe.skipIf(process.platform === 'win32')('独立评测进程的生命周期', { timeout: 15_000 }, () => {
  it('正常退出保留退出码和原始参数并移除信号监听', async () => {
    await start('exit', ['包含 空格', 'literal; echo nope'])
    await waitExit(7)
    expect(JSON.parse(await readFile(path.join(directory!, 'args.json'), 'utf8'))).toEqual([
      '包含 空格',
      'literal; echo nope',
    ])
  })

  it('缺少评测程序时返回明确错误并移除信号监听', async () => {
    await start('missing')
    await waitExit(2)
    expect(captured).toContain('评测工具未安装或无法启动')
  })

  it('评测程序没有执行权限时也会释放信号监听', async () => {
    await start('permission-denied')
    await waitExit(2)
    expect(captured).toContain('评测工具未安装或无法启动')
  })

  it('同步启动失败不会遗留信号监听', async () => {
    await start('exit', ['不允许\0空字符'])
    await waitExit(2)
    expect(captured).toContain('评测工具未安装或无法启动')
  })

  it('评测子进程自身被信号终止时保留对应退出状态', async () => {
    await start('self-signal')
    await waitExit(143)
  })

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ] as const)('收到 %s 后转发取消并清理残留后代进程', async (signal, code) => {
    const child = await start('graceful')
    const pids = await waitReady()
    child.kill(signal)
    await waitExit(code)
    expect(await readFile(path.join(directory!, 'signals'), 'utf8')).toContain(signal)
    await expect.poll(() => pids.some(alive), { timeout: 3_000 }).toBe(false)
  })

  it('评测进程忽略取消信号时超时强制终止整个进程组', async () => {
    const child = await start('stubborn')
    const pids = await waitReady()
    child.kill('SIGTERM')
    await waitExit(143)
    await expect.poll(() => pids.some(alive), { timeout: 3_000 }).toBe(false)
  })

  it('重复取消不会丢失原始取消退出码或留下进程', async () => {
    const child = await start('stubborn')
    const pids = await waitReady()
    child.kill('SIGTERM')
    await expect.poll(() => readFile(path.join(directory!, 'signals'), 'utf8')).toContain('SIGTERM')
    child.kill('SIGINT')
    await waitExit(143)
    await expect.poll(() => pids.some(alive), { timeout: 3_000 }).toBe(false)
  })
})
