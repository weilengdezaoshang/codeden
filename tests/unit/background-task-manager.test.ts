import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackgroundTaskManager } from '../../packages/agent-runtime/src/tools/background-task-manager.js'

describe('测试套件：BackgroundTaskManager killAll', () => {
  it('验证：killAll 终止全部运行中的任务且可重复调用', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-bg-kill-'))
    const manager = new BackgroundTaskManager()
    const longRunning = {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      workspaceRoot: root,
      timeoutMs: 0,
    }
    const first = await manager.start(longRunning)
    const second = await manager.start(longRunning)
    try {
      expect(first.status).toBe('running')
      expect(second.status).toBe('running')

      const killed = await manager.killAll('unit-test')
      expect(killed.map((task) => task.taskId).sort()).toEqual([first.taskId, second.taskId].sort())

      expect((await manager.get(first.taskId)).status).toBe('killed')
      expect((await manager.get(second.taskId)).status).toBe('killed')
      expect(await manager.killAll('unit-test')).toHaveLength(0)
    } finally {
      await manager.killAll('unit-test-cleanup')
    }
  })

  it('验证：killAll 只影响运行中的任务', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-bg-exit-'))
    const manager = new BackgroundTaskManager()
    const finished = await manager.start({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      workspaceRoot: root,
      timeoutMs: 0,
    })
    for (let i = 0; i < 50 && (await manager.get(finished.taskId)).status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(await manager.killAll('unit-test')).toHaveLength(0)
    expect((await manager.get(finished.taskId)).status).toBe('completed')
  })
})
