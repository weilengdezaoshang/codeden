import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { ApplyPatchTool } from '../../packages/agent-runtime/src/tools/builtins/apply-patch.js'
import { AskUserTool } from '../../packages/agent-runtime/src/tools/builtins/ask-user.js'
import { FindReferencesTool } from '../../packages/agent-runtime/src/tools/builtins/find-references.js'
import { FindSymbolTool } from '../../packages/agent-runtime/src/tools/builtins/find-symbol.js'
import { RepoMapTool } from '../../packages/agent-runtime/src/tools/builtins/repo-map.js'
import { TodoWriteTool } from '../../packages/agent-runtime/src/tools/builtins/todo-write.js'
import { BackgroundTaskManager } from '../../packages/agent-runtime/src/tools/background-task-manager.js'
import { createDefaultToolRegistry } from '../../packages/agent-runtime/src/create-codeden-runtime.js'
import type { ToolContext } from '../../packages/agent-runtime/src/tools/tool.js'
import { WorkspacePolicy } from '../../packages/agent-runtime/src/workspace/workspace-policy.js'

async function context(root?: string): Promise<ToolContext> {
  root ??= await mkdtemp(path.join(tmpdir(), 'codeden-tool-surface-'))
  return {
    workspaceRoot: root,
    policy: new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: true,
    }),
    eventSink: new NoopEventSink(),
  }
}

describe('测试套件：expanded tool surface', () => {
  it('验证：default registry exposes all P0/P1/P2 tools', () => {
    const expected = [
      'apply_patch',
      'start_command',
      'get_command_output',
      'kill_command',
      'get_diagnostics',
      'git_status',
      'git_diff',
      'delete_file',
      'move_file',
      'todo_write',
      'ask_user',
      'web_search',
      'web_fetch',
      'repo_map',
      'find_symbol',
      'find_references',
      'read_many_files',
    ]
    const names = new Set(
      createDefaultToolRegistry()
        .definitions()
        .map((tool) => tool.name),
    )
    expect(expected.every((name) => names.has(name))).toBe(true)
  })

  it('验证：apply_patch can add, update, move, and delete files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-patch-'))
    await writeFile(path.join(root, 'note.txt'), 'alpha\nbeta\n', 'utf8')
    const ctx = await context(root)
    const tool = new ApplyPatchTool()

    await tool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Add File: added.txt',
          '+created',
          '*** Update File: note.txt',
          '*** Move to: moved.txt',
          '@@',
          ' alpha',
          '-beta',
          '+delta',
          '*** End Patch',
        ].join('\n'),
      },
      ctx,
    )

    expect(await readFile(path.join(root, 'added.txt'), 'utf8')).toBe('created')
    expect(await readFile(path.join(root, 'moved.txt'), 'utf8')).toBe('alpha\ndelta\n')
    await tool.execute({ patch: '*** Begin Patch\n*** Delete File: moved.txt\n*** End Patch' }, ctx)
    await expect(readFile(path.join(root, 'moved.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('验证：background task manager returns completed output and supports offsets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-background-'))
    const manager = new BackgroundTaskManager()
    const started = await manager.start({
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write('first'); setTimeout(() => process.stdout.write(' second'), 20)",
      ],
      workspaceRoot: root,
      timeoutMs: 5_000,
    })
    let completed = await manager.get(started.taskId, { waitMs: 1_000 })
    while (completed.status === 'running') {
      completed = await manager.get(started.taskId, { waitMs: 1_000 })
    }
    expect(completed.status).toBe('completed')
    expect(completed.stdout).toContain('first')
    const offset = await manager.get(started.taskId, { stdoutOffset: 'first'.length })
    expect(offset.stdout).toContain(' second')
  })

  it('验证：code navigation tools find definitions and references', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-index-'))
    await writeFile(
      path.join(root, 'sample.ts'),
      'export function greet() {}\nconst message = greet()\n',
      'utf8',
    )
    const ctx = await context(root)
    const symbol = await new FindSymbolTool().execute(
      { name: 'greet', path: '.', maxResults: 50 },
      ctx,
    )
    const references = await new FindReferencesTool().execute(
      { name: 'greet', path: '.', maxResults: 100, excludeDefinitions: false },
      ctx,
    )
    const map = await new RepoMapTool().execute({ path: '.', maxFiles: 10, maxSymbols: 10 }, ctx)
    expect(symbol.results).toHaveLength(1)
    expect(references.results).toHaveLength(2)
    expect(map.symbolCount).toBe(2)
  })

  it('验证：todo_write replaces workspace plan and ask_user delegates to context', async () => {
    const ctx = await context()
    const todos = new TodoWriteTool()
    await todos.execute(
      {
        todos: [{ id: 'one', content: 'Implement tools', status: 'in_progress', priority: 'high' }],
      },
      ctx,
    )
    expect(todos.current(ctx.workspaceRoot)[0]?.status).toBe('in_progress')
    const answer = await new AskUserTool().execute(
      { question: 'Which mode?', options: ['safe', 'fast'] },
      { ...ctx, askUser: async () => 'safe' },
    )
    expect(answer).toMatchObject({ answer: 'safe' })
  })

  it('验证：web_fetch rejects private destinations before network access', async () => {
    const { WebFetchTool } =
      await import('../../packages/agent-runtime/src/tools/builtins/web-fetch.js')
    await expect(
      new WebFetchTool().execute({ url: 'https://127.0.0.1/', maxBytes: 1_000 }, await context()),
    ).rejects.toThrow('IP address URLs are not allowed')
  })
})
