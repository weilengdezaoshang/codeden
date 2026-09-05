import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { RunPythonTool } from '../../packages/agent-runtime/src/tools/builtins/run-python.js'
import { WorkspacePolicy } from '../../packages/agent-runtime/src/workspace/workspace-policy.js'

describe('测试套件：RunPythonTool', () => {
  it('验证：在 workspace 内无 shell 执行 Python 脚本并返回结果', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-python-'))
    const realRoot = await realpath(root)
    await writeFile(path.join(root, 'hello.py'), 'print("hello")\n', 'utf8')
    const run = vi.fn(async (command: { command: string; args: string[] }) => ({
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      durationMs: 2,
      command,
    }))
    const tool = new RunPythonTool({
      interpreter: 'python3',
      runner: { run, dispose: vi.fn(async () => undefined) },
    })

    const result = await tool.execute(
      { script: 'hello.py', args: ['world'], timeoutMs: 1000 },
      context(root),
    )

    expect(result).toMatchObject({
      script: 'hello.py',
      interpreter: 'python3',
      exitCode: 0,
      stdout: 'hello\n',
    })
    expect(run).toHaveBeenCalledWith(
      {
        command: 'python3',
        args: [path.join(realRoot, 'hello.py'), 'world'],
        timeoutMs: 1000,
      },
      expect.objectContaining({ workspaceRoot: root }),
    )
  })

  it('验证：拒绝 workspace 外的脚本路径', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-python-'))
    const run = vi.fn()
    const tool = new RunPythonTool({
      runner: { run, dispose: vi.fn(async () => undefined) },
    })

    await expect(
      tool.execute({ script: '../outside.py', args: [], timeoutMs: 1000 }, context(root)),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_DENIED' })
    expect(run).not.toHaveBeenCalled()
  })
})

function context(workspaceRoot: string) {
  return {
    workspaceRoot,
    policy: new WorkspacePolicy(workspaceRoot, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: true,
    }),
    eventSink: new NoopEventSink(),
  }
}
