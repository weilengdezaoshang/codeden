import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../packages/core/src/clock.js'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { WorkspacePolicy } from '../../packages/agent-runtime/src/workspace/workspace-policy.js'
import { ToolExecutor } from '../../packages/agent-runtime/src/tools/tool-executor.js'
import { ToolRegistry } from '../../packages/agent-runtime/src/tools/tool-registry.js'
import type { Tool } from '../../packages/agent-runtime/src/tools/tool.js'
import { ListFilesTool } from '../../packages/agent-runtime/src/tools/builtins/list-files.js'
import { RunCommandTool } from '../../packages/agent-runtime/src/tools/builtins/run-command.js'
import { TodoWriteTool } from '../../packages/agent-runtime/src/tools/builtins/todo-write.js'
import { z } from 'zod'

class RecordingSink extends NoopEventSink {
  readonly events: string[] = []
  override async emit(_source: 'tool', type: string): Promise<void> {
    this.events.push(type)
  }
}

function makeExecutor(
  tool: Tool | Tool[],
  options?: {
    max?: number
    timeoutMs?: number
    approvalMode?: 'ask' | 'auto'
    confirmTool?: (toolName: string, arguments_: unknown) => Promise<boolean>
  },
) {
  const registry = new ToolRegistry()
  for (const item of Array.isArray(tool) ? tool : [tool]) {
    registry.register(item)
  }
  const sink = new RecordingSink()
  const executor = new ToolExecutor({
    registry,
    budget: { maxToolCalls: options?.max ?? 2, used: 0 },
    eventSink: sink,
    clock: new FakeClock(),
    timeoutMs: options?.timeoutMs ?? 50,
    context: {
      workspaceRoot: process.cwd(),
      policy: new WorkspacePolicy(process.cwd(), {
        readableRoots: ['.'],
        writableRoots: ['.'],
        allowCommands: true,
      }),
      eventSink: sink,
      approvalMode: options?.approvalMode,
      confirmTool: options?.confirmTool,
    },
  })
  return { executor, sink }
}

const EchoSchema = z.object({ value: z.string() })

const echoTool: Tool<{ value: string }> = {
  name: 'echo',
  description: 'echo',
  inputSchema: EchoSchema,
  sideEffect: 'read',
  async execute(input) {
    return input.value
  },
}

describe('测试套件：ToolExecutor', () => {
  it('验证：todo_write 免审批直接执行', async () => {
    const confirmTool = vi.fn(async () => false)
    const { executor } = makeExecutor(new TodoWriteTool(), { confirmTool })
    const result = await executor.execute({
      id: 'call-todo',
      name: 'todo_write',
      arguments: {
        todos: [{ id: '1', content: '第一步', status: 'pending', priority: 'medium' }],
      },
    })
    expect(result.ok).toBe(true)
    expect(confirmTool).not.toHaveBeenCalled()
  })

  it('验证：requires both documentation search and fetch for research evidence', async () => {
    const searchTool: Tool = {
      name: 'search_docs',
      description: 'search',
      inputSchema: z.object({}),
      sideEffect: 'read',
      async execute() {
        return { results: [{ url: 'https://nodejs.org/api/fs.html' }] }
      },
    }
    const fetchTool: Tool = {
      name: 'fetch_url',
      description: 'fetch',
      inputSchema: z.object({}),
      sideEffect: 'read',
      async execute() {
        return { url: 'https://nodejs.org/api/fs.html', content: 'page' }
      },
    }
    const { executor } = makeExecutor([searchTool, fetchTool])
    expect(executor.hasSuccessfulResearch()).toBe(false)
    await executor.execute({ id: 'search', name: 'search_docs', arguments: {} })
    expect(executor.hasSuccessfulResearch()).toBe(false)
    await executor.execute({ id: 'fetch', name: 'fetch_url', arguments: {} })
    expect(executor.hasSuccessfulResearch()).toBe(true)
  })

  it('验证：executes a known tool', async () => {
    const { executor, sink } = makeExecutor(echoTool)
    const result = await executor.execute({ id: 'c1', name: 'echo', arguments: { value: 'ok' } })
    expect(result).toMatchObject({ ok: true, output: 'ok' })
    expect(sink.events).toEqual(['tool.started', 'tool.completed'])
  })

  it('验证：只读工具不触发权限确认', async () => {
    const confirmTool = vi.fn(async () => false)
    const { executor } = makeExecutor(echoTool, { confirmTool })

    const result = await executor.execute({ id: 'read', name: 'echo', arguments: { value: 'ok' } })

    expect(result).toMatchObject({ ok: true, output: 'ok' })
    expect(confirmTool).not.toHaveBeenCalled()
  })

  it('验证：list_files 可以无权限列出项目结构', async () => {
    const confirmTool = vi.fn(async () => false)
    const { executor } = makeExecutor(new ListFilesTool(), { confirmTool })

    const result = await executor.execute({
      id: 'list',
      name: 'list_files',
      arguments: { path: '.', maxDepth: 0, maxEntries: 1_000 },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.output as { entries: string[] }).entries).toContain('package.json')
    }
    expect(confirmTool).not.toHaveBeenCalled()
  })

  it('验证：run_command 的只读命令无需权限，其他命令仍需权限', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: 'content', stderr: '', durationMs: 1 }))
    const runner = { run, dispose: vi.fn(async () => undefined) }
    const confirmTool = vi.fn(async () => false)
    const { executor } = makeExecutor(new RunCommandTool({ runner }), { max: 3, confirmTool })

    const readResult = await executor.execute({
      id: 'ls',
      name: 'run_command',
      arguments: { command: 'ls', args: [] },
    })
    const catResult = await executor.execute({
      id: 'cat',
      name: 'run_command',
      arguments: { command: 'cat', args: ['package.json'] },
    })
    const deniedResult = await executor.execute({
      id: 'install',
      name: 'run_command',
      arguments: { command: 'pnpm', args: ['install'] },
    })

    expect(readResult).toMatchObject({ ok: true, output: { stdout: 'content' } })
    expect(catResult).toMatchObject({ ok: true, output: { stdout: 'content' } })
    expect(deniedResult).toMatchObject({ ok: false, error: { code: 'TOOL_PERMISSION_DENIED' } })
    expect(confirmTool).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('验证：returns a failed result for an unknown tool', async () => {
    const { executor, sink } = makeExecutor(echoTool)
    const result = await executor.execute({ id: 'c1', name: 'missing', arguments: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('TOOL_NOT_FOUND')
    }
    expect(sink.events).toEqual(['tool.failed'])
  })

  it('验证：does not execute a tool when arguments are invalid', async () => {
    let ran = false
    const tool: Tool<{ value: string }> = {
      ...echoTool,
      async execute(input) {
        ran = true
        return input.value
      },
    }
    const { executor } = makeExecutor(tool)
    const result = await executor.execute({ id: 'c1', name: 'echo', arguments: { value: 1 } })
    expect(result.ok).toBe(false)
    expect(ran).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('TOOL_INPUT_INVALID')
    }
  })

  it('验证：captures a thrown tool exception as a failed result', async () => {
    const tool: Tool<{ value: string }> = {
      ...echoTool,
      async execute() {
        throw new Error('boom')
      },
    }
    const { executor, sink } = makeExecutor(tool)
    const result = await executor.execute({ id: 'c1', name: 'echo', arguments: { value: 'x' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('TOOL_EXECUTION_FAILED')
    }
    expect(sink.events).toEqual(['tool.started', 'tool.failed'])
  })

  it('验证：times out a hanging tool', async () => {
    const tool: Tool<{ value: string }> = {
      ...echoTool,
      async execute() {
        await new Promise(() => undefined)
        return 'never'
      },
    }
    const { executor } = makeExecutor(tool, { timeoutMs: 20 })
    const result = await executor.execute({ id: 'c1', name: 'echo', arguments: { value: 'x' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('COMMAND_TIMEOUT')
    }
  })

  it('验证：fails when the tool-call budget is exhausted', async () => {
    const { executor } = makeExecutor(echoTool, { max: 1 })
    await executor.execute({ id: 'c1', name: 'echo', arguments: { value: 'a' } })
    const result = await executor.execute({ id: 'c2', name: 'echo', arguments: { value: 'b' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_BUDGET_EXHAUSTED')
    }
  })

  it('验证：执行有副作用的工具前请求确认并支持拒绝', async () => {
    let executed = false
    const writeTool: Tool<{ value: string }> = {
      name: 'write-test',
      description: 'write',
      inputSchema: EchoSchema,
      sideEffect: 'write',
      async execute() {
        executed = true
        return 'written'
      },
    }
    const registry = new ToolRegistry()
    registry.register(writeTool)
    const sink = new RecordingSink()
    const executor = new ToolExecutor({
      registry,
      budget: { maxToolCalls: 2, used: 0 },
      eventSink: sink,
      clock: new FakeClock(),
      context: {
        workspaceRoot: process.cwd(),
        policy: new WorkspacePolicy(process.cwd(), {
          readableRoots: ['.'],
          writableRoots: ['.'],
          allowCommands: true,
        }),
        eventSink: sink,
        confirmTool: async () => false,
      },
    })
    const result = await executor.execute({
      id: 'deny',
      name: 'write-test',
      arguments: { value: 'x' },
    })
    expect(result.ok).toBe(false)
    expect(executed).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('TOOL_PERMISSION_DENIED')
    }
  })

  it('验证：自动权限模式跳过副作用工具的用户确认', async () => {
    const confirmTool = vi.fn(async () => false)
    const writeTool: Tool<{ value: string }> = {
      name: 'write-auto-test',
      description: 'write',
      inputSchema: EchoSchema,
      sideEffect: 'write',
      async execute(input) {
        return input.value
      },
    }
    const { executor } = makeExecutor(writeTool, { approvalMode: 'auto', confirmTool })

    const result = await executor.execute({
      id: 'auto',
      name: 'write-auto-test',
      arguments: { value: 'written' },
    })

    expect(result).toMatchObject({ ok: true, output: 'written' })
    expect(confirmTool).not.toHaveBeenCalled()
  })

  it('验证：工具确认回调可以收到取消信号', async () => {
    const controller = new AbortController()
    const confirmTool = vi.fn(async () => false)
    const registry = new ToolRegistry()
    registry.register({
      name: 'confirm-signal-test',
      description: 'write',
      inputSchema: EchoSchema,
      sideEffect: 'write',
      async execute() {
        return 'written'
      },
    })
    const sink = new RecordingSink()
    const executor = new ToolExecutor({
      registry,
      budget: { maxToolCalls: 1, used: 0 },
      eventSink: sink,
      clock: new FakeClock(),
      context: {
        workspaceRoot: process.cwd(),
        policy: new WorkspacePolicy(process.cwd(), {
          readableRoots: ['.'],
          writableRoots: ['.'],
          allowCommands: true,
        }),
        eventSink: sink,
        abortSignal: controller.signal,
        confirmTool,
      },
    })

    await executor.execute({
      id: 'signal',
      name: 'confirm-signal-test',
      arguments: { value: 'x' },
    })
    expect(confirmTool).toHaveBeenCalledWith(
      'confirm-signal-test',
      { value: 'x' },
      controller.signal,
    )
  })
})
