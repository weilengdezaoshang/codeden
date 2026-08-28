import { describe, expect, it, vi } from 'vitest'
import type { AgentPort } from '../../src/eval/ports/agent.port.js'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { WorkspacePolicy } from '../../src/runtime/workspace/workspace-policy.js'
import { SubagentTool } from '../../src/runtime/tools/builtins/subagent.js'
import { ToolExecutor } from '../../src/runtime/tools/tool-executor.js'
import { ToolRegistry } from '../../src/runtime/tools/tool-registry.js'
import { FakeClock } from '../../src/core/clock.js'

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
      },
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      readOnly: true,
      subagentDepth: 1,
      limits: { maxTurns: 3, maxToolCalls: 6 },
    })
    expect(output).toMatchObject({ finalResponse: '子任务完成' })
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
})
