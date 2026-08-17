import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../src/core/clock.js'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { WorkspacePolicy } from '../../src/runtime/workspace/workspace-policy.js'
import { ToolExecutor } from '../../src/runtime/tools/tool-executor.js'
import { ToolRegistry } from '../../src/runtime/tools/tool-registry.js'
import type { Tool } from '../../src/runtime/tools/tool.js'
import { z } from 'zod'

class RecordingSink extends NoopEventSink {
  readonly events: string[] = []
  override async emit(_source: 'tool', type: string): Promise<void> {
    this.events.push(type)
  }
}

function makeExecutor(tool: Tool, options?: { max?: number; timeoutMs?: number }) {
  const registry = new ToolRegistry()
  registry.register(tool)
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

describe('ToolExecutor', () => {
  it('executes a known tool', async () => {
    const { executor, sink } = makeExecutor(echoTool)
    const result = await executor.execute({ id: 'c1', name: 'echo', arguments: { value: 'ok' } })
    expect(result).toMatchObject({ ok: true, output: 'ok' })
    expect(sink.events).toEqual(['tool.started', 'tool.completed'])
  })

  it('returns a failed result for an unknown tool', async () => {
    const { executor, sink } = makeExecutor(echoTool)
    const result = await executor.execute({ id: 'c1', name: 'missing', arguments: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('TOOL_NOT_FOUND')
    }
    expect(sink.events).toEqual(['tool.failed'])
  })

  it('does not execute a tool when arguments are invalid', async () => {
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

  it('captures a thrown tool exception as a failed result', async () => {
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

  it('times out a hanging tool', async () => {
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

  it('fails when the tool-call budget is exhausted', async () => {
    const { executor } = makeExecutor(echoTool, { max: 1 })
    await executor.execute({ id: 'c1', name: 'echo', arguments: { value: 'a' } })
    const result = await executor.execute({ id: 'c2', name: 'echo', arguments: { value: 'b' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_BUDGET_EXHAUSTED')
    }
  })
})
