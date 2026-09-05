import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnInProcessGroup, killProcessGroup } from '../process/kill-process-group.js'
import { pickCommandEnv } from '../process-env.js'

const MAX_OUTPUT_CHARS = 1_000_000

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface BackgroundTaskSnapshot {
  taskId: string
  command: string
  args: string[]
  status: BackgroundTaskStatus
  exitCode?: number
  signal?: string
  stdout: string
  stderr: string
  stdoutLength: number
  stderrLength: number
  truncated: boolean
  startedAt: string
  finishedAt?: string
}

interface BackgroundTask extends BackgroundTaskSnapshot {
  child: ReturnType<typeof spawnInProcessGroup>
  home: string
  timer?: ReturnType<typeof setTimeout>
  waiters: Set<() => void>
}

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTask>()

  async start(input: {
    command: string
    args: string[]
    workspaceRoot: string
    timeoutMs: number
    abortSignal?: AbortSignal
  }): Promise<BackgroundTaskSnapshot> {
    const taskId = randomUUID()
    const home = await mkdtemp(`${tmpdir()}/codeden-task-home-`)
    let child: BackgroundTask['child']
    try {
      child = spawnInProcessGroup(input.command, input.args, {
        cwd: input.workspaceRoot,
        env: pickCommandEnv({ HOME: home, TMPDIR: tmpdir() }),
      })
    } catch (error) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }

    const task: BackgroundTask = {
      taskId,
      command: input.command,
      args: [...input.args],
      status: 'running',
      stdout: '',
      stderr: '',
      stdoutLength: 0,
      stderrLength: 0,
      truncated: false,
      startedAt: new Date().toISOString(),
      child,
      home,
      waiters: new Set(),
    }
    this.tasks.set(taskId, task)

    child.stdout?.on('data', (chunk: Buffer) => {
      this.append(task, 'stdout', chunk.toString('utf8'))
      this.notify(task)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.append(task, 'stderr', chunk.toString('utf8'))
      this.notify(task)
    })
    child.on('error', (error) => {
      if (task.status !== 'running') {
        return
      }
      task.status = 'failed'
      task.stderr = appendBounded(task.stderr, error.message, task)
      task.stderrLength += error.message.length
      task.finishedAt = new Date().toISOString()
      this.notify(task)
      void this.cleanup(task)
    })
    child.on('close', (exitCode, signal) => {
      if (task.status === 'running') {
        task.exitCode = exitCode ?? undefined
        task.signal = signal ?? undefined
        task.status = exitCode === 0 ? 'completed' : 'failed'
        task.finishedAt = new Date().toISOString()
      }
      this.notify(task)
      void this.cleanup(task)
    })

    if (input.timeoutMs > 0) {
      task.timer = setTimeout(() => {
        void this.kill(taskId, 'timeout')
      }, input.timeoutMs)
    }
    if (input.abortSignal) {
      const onAbort = () => {
        void this.kill(taskId, 'aborted')
      }
      input.abortSignal.addEventListener('abort', onAbort, { once: true })
      child.once('close', () => input.abortSignal?.removeEventListener('abort', onAbort))
    }

    return snapshotOf(task)
  }

  async get(
    taskId: string,
    options: { waitMs?: number; stdoutOffset?: number; stderrOffset?: number } = {},
  ): Promise<BackgroundTaskSnapshot> {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new Error(`Background task not found: ${taskId}`)
    }
    const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), 30_000)
    if (task.status === 'running' && waitMs > 0) {
      await this.waitForChange(task, waitMs)
    }
    const snapshot = snapshotOf(task)
    const stdoutOffset = clampOffset(options.stdoutOffset ?? 0, snapshot.stdout.length)
    const stderrOffset = clampOffset(options.stderrOffset ?? 0, snapshot.stderr.length)
    return {
      ...snapshot,
      stdout: snapshot.stdout.slice(stdoutOffset),
      stderr: snapshot.stderr.slice(stderrOffset),
    }
  }

  async kill(taskId: string, reason = 'killed'): Promise<BackgroundTaskSnapshot> {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new Error(`Background task not found: ${taskId}`)
    }
    if (task.status === 'running') {
      task.status = 'killed'
      task.signal = reason
      task.finishedAt = new Date().toISOString()
      killProcessGroup(task.child)
      this.notify(task)
    }
    return snapshotOf(task)
  }

  /** 终止全部仍在运行的后台任务；会话切换或进程退出时调用，避免孤儿进程与临时目录泄漏。 */
  async killAll(reason = 'shutdown'): Promise<BackgroundTaskSnapshot[]> {
    const snapshots: BackgroundTaskSnapshot[] = []
    for (const task of [...this.tasks.values()]) {
      if (task.status === 'running') {
        snapshots.push(await this.kill(task.taskId, reason))
      }
    }
    return snapshots
  }

  private append(task: BackgroundTask, stream: 'stdout' | 'stderr', value: string): void {
    if (stream === 'stdout') {
      task.stdoutLength += value.length
      task.stdout = appendBounded(task.stdout, value, task)
    } else {
      task.stderrLength += value.length
      task.stderr = appendBounded(task.stderr, value, task)
    }
  }

  private async waitForChange(task: BackgroundTask, waitMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        task.waiters.delete(waiter)
        resolve()
      }, waitMs)
      const waiter = () => {
        clearTimeout(timer)
        task.waiters.delete(waiter)
        resolve()
      }
      task.waiters.add(waiter)
    })
  }

  private notify(task: BackgroundTask): void {
    for (const waiter of task.waiters) {
      waiter()
    }
    task.waiters.clear()
  }

  private async cleanup(task: BackgroundTask): Promise<void> {
    if (task.timer) {
      clearTimeout(task.timer)
      task.timer = undefined
    }
    await rm(task.home, { recursive: true, force: true }).catch(() => undefined)
  }
}

function appendBounded(previous: string, value: string, task: BackgroundTask): string {
  const next = previous + value
  if (next.length <= MAX_OUTPUT_CHARS) {
    return next
  }
  task.truncated = true
  return next.slice(next.length - MAX_OUTPUT_CHARS)
}

function clampOffset(value: number, length: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), length) : 0
}

function snapshotOf(task: BackgroundTask): BackgroundTaskSnapshot {
  return {
    taskId: task.taskId,
    command: task.command,
    args: [...task.args],
    status: task.status,
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    ...(task.signal === undefined ? {} : { signal: task.signal }),
    stdout: task.stdout,
    stderr: task.stderr,
    stdoutLength: task.stdoutLength,
    stderrLength: task.stderrLength,
    truncated: task.truncated,
    startedAt: task.startedAt,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
  }
}
