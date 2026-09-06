import { describe, expect, it, vi } from 'vitest'
import type { AgentPort } from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { WorkspacePolicy } from '../../packages/agent-runtime/src/workspace/workspace-policy.js'
import { SubagentTool } from '../../packages/agent-runtime/src/tools/builtins/subagent.js'
import { ToolExecutor } from '../../packages/agent-runtime/src/tools/tool-executor.js'
import { ToolRegistry } from '../../packages/agent-runtime/src/tools/tool-registry.js'
import { FakeClock } from '../../packages/core/src/clock.js'
import { ErrorCodes } from '../../packages/core/src/errors/error-codes.js'

describe('测试套件：SubagentTool', () => {
  it('验证：以只读、有限预算和递归深度调用子 Agent', async () => {
    const run = vi.fn(async (_task, context) => ({
      status: 'submitted' as const,
      finalResponse: '子任务完成',
      metrics: {} as never,
      context,
    }))
    const agent = { name: 'fake', run } as unknown as AgentPort
    const tool = new SubagentTool(agent)
    const output = await tool.execute(
      { prompt: '分析代码', readOnly: true },
      {
        workspaceRoot: process.cwd(),
        policy: new WorkspacePolicy(process.cwd(), {
          readableRoots: ['.'],
          writableRoots: [],
          allowCommands: false,
        }),
        eventSink: new NoopEventSink(),
        subagentDepth: 0,
        allowedPaths: ['src', 'README.md'],
      },
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      readOnly: true,
      subagentDepth: 1,
      limits: { maxTurns: 3, maxToolCalls: 6 },
      allowedPaths: ['src', 'README.md'],
    })
    // 默认 summary 模式：父上下文只收结构化摘要。
    const summary = output as { summary: string; degraded: boolean; status: string }
    expect(summary.status).toBe('submitted')
    expect(summary.summary).toContain('已完成（未验证）')
    expect(summary.summary).toContain('[结论] 子任务完成')
    expect(summary.degraded).toBe(false)
  })

  it('验证：full 模式保留完整子任务结果（回滚开关）', async () => {
    const run = vi.fn(async () => ({
      status: 'submitted' as const,
      finalResponse: '子任务完成',
      metrics: {} as never,
    }))
    const agent = { name: 'fake', run } as unknown as AgentPort
    const tool = new SubagentTool(agent, { summaryMode: 'full' })
    const output = await tool.execute(
      { prompt: '分析代码', readOnly: true },
      {
        workspaceRoot: process.cwd(),
        policy: new WorkspacePolicy(process.cwd(), {
          readableRoots: ['.'],
          writableRoots: [],
          allowCommands: false,
        }),
        eventSink: new NoopEventSink(),
        subagentDepth: 0,
      },
    )
    expect(output).toMatchObject({ finalResponse: '子任务完成' })
  })

  it('验证：未完成的子任务显式标注且不摘要为成功（EX-13 语义）', async () => {
    const run = vi.fn(async () => ({
      status: 'timeout' as const,
      stopReason: 'timeout',
      finalResponse: '',
      metrics: { turns: 2, toolCalls: 1, toolFailures: 1 } as never,
    }))
    const agent = { name: 'fake', run } as unknown as AgentPort
    const tool = new SubagentTool(agent)
    const output = (await tool.execute(
      { prompt: '超时的子任务', readOnly: true },
      {
        workspaceRoot: process.cwd(),
        policy: new WorkspacePolicy(process.cwd(), {
          readableRoots: ['.'],
          writableRoots: [],
          allowCommands: false,
        }),
        eventSink: new NoopEventSink(),
        subagentDepth: 0,
      },
    )) as { summary: string; degraded: boolean; status: string; turnCount: number }
    expect(output.status).toBe('timeout')
    expect(output.summary).toContain('未完成（超时或被取消）')
    expect(output.summary).toContain('终止原因 timeout')
    expect(output.summary).toContain('[结论] （无最终回复）')
    expect(output.summary).not.toContain('已完成')
    expect(output.turnCount).toBe(2)
  })

  it('验证：结论超出预算时强制截断并标记 degraded', async () => {
    const run = vi.fn(async () => ({
      status: 'verified_complete' as const,
      finalResponse: '长'.repeat(5_000),
      metrics: { turns: 1, toolCalls: 0, toolFailures: 0 } as never,
    }))
    const agent = { name: 'fake', run } as unknown as AgentPort
    const tool = new SubagentTool(agent, { summaryBudgetChars: 500 })
    const output = (await tool.execute(
      { prompt: '超长结论', readOnly: true },
      {
        workspaceRoot: process.cwd(),
        policy: new WorkspacePolicy(process.cwd(), {
          readableRoots: ['.'],
          writableRoots: [],
          allowCommands: false,
        }),
        eventSink: new NoopEventSink(),
        subagentDepth: 0,
      },
    )) as { summary: string; degraded: boolean }
    expect(output.degraded).toBe(true)
    expect(Array.from(output.summary).length).toBeLessThanOrEqual(500)
    expect(output.summary).toContain('…')
  })

  it('验证：在执行层拒绝递归子 Agent 调用', async () => {
    const registry = new ToolRegistry()
    registry.register(new SubagentTool({ name: 'fake', run: vi.fn() } as unknown as AgentPort))
    const executor = new ToolExecutor({
      registry,
      context: {
        workspaceRoot: process.cwd(),
        policy: new WorkspacePolicy(process.cwd(), {
          readableRoots: ['.'],
          writableRoots: [],
          allowCommands: false,
        }),
        eventSink: new NoopEventSink(),
        subagentDepth: 1,
      },
      budget: { maxToolCalls: 2, used: 0 },
      eventSink: new NoopEventSink(),
      clock: new FakeClock(),
    })
    const result = await executor.execute({
      id: 'nested',
      name: 'subagent',
      arguments: { prompt: '递归' },
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.message).toContain('Nested subagents')
  })

  it('验证：拒绝可写子 Agent，避免绕过父任务写回流程', async () => {
    const tool = new SubagentTool({ name: 'fake', run: vi.fn() } as unknown as AgentPort)
    await expect(
      tool.execute(
        { prompt: '修改文件', readOnly: false },
        {
          workspaceRoot: process.cwd(),
          policy: new WorkspacePolicy(process.cwd(), {
            readableRoots: ['.'],
            writableRoots: ['.'],
            allowCommands: true,
          }),
          eventSink: new NoopEventSink(),
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.TOOL_PERMISSION_DENIED })
  })

  it('验证：并发超过上限时排队，并在父信号取消后退出排队', async () => {
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const run = vi.fn(async () => {
      await firstStarted
      return { status: 'submitted' as const, finalResponse: '完成', metrics: {} as never }
    })
    const tool = new SubagentTool({ name: 'fake', run } as unknown as AgentPort, {
      maxConcurrent: 1,
    })
    const baseContext = {
      workspaceRoot: process.cwd(),
      policy: new WorkspacePolicy(process.cwd(), {
        readableRoots: ['.'],
        writableRoots: [],
        allowCommands: false,
      }),
      eventSink: new NoopEventSink(),
    }
    const first = tool.execute({ prompt: '一', readOnly: true }, baseContext)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const second = tool.execute(
      { prompt: '二', readOnly: true },
      { ...baseContext, abortSignal: controller.signal },
    )
    controller.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    releaseFirst()
    await first
    expect(run).toHaveBeenCalledTimes(1)
  })
})
