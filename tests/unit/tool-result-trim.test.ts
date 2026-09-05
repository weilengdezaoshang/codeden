import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { createSecurityServices } from '../../packages/core/src/security/security-services.js'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import type { AgentRunContext } from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import { AgentRunner } from '../../packages/agent-runtime/src/agent/agent-runner.js'
import { createAgentDeps } from '../../packages/agent-runtime/src/create-codeden-runtime.js'
import type { ContextBudgetPolicy } from '../../packages/agent-runtime/src/context/context-budget.js'
import type { ModelProvider } from '../../packages/agent-runtime/src/models/model-provider.js'
import type {
  ModelRequest,
  ModelResponse,
} from '../../packages/agent-runtime/src/models/model-types.js'
import { toolCall } from '../../packages/agent-runtime/src/models/mock-model-provider.js'
import type { Tool } from '../../packages/agent-runtime/src/tools/tool.js'

const task = {
  prompt: '拉取大输出',
  taskSpec: parseTaskSpec({ id: 't', goal: '拉取大输出' }),
}

function context(): AgentRunContext {
  return {
    runId: 'run',
    trialId: 'trial',
    workspace: {
      root: process.cwd(),
      async changedPaths() {
        return []
      },
    },
    eventSink: new NoopEventSink(),
    limits: { maxTurns: 5, maxToolCalls: 5 },
    submissionType: 'text',
    readOnly: true,
  }
}

/** 先返回一次工具调用、再收尾的两段式 mock 模型，同时捕获每次请求消息。 */
function twoStepModel(captured: ModelRequest[]): ModelProvider {
  let step = 0
  return {
    name: 'trim-mock',
    descriptor: { model: 'claude-sonnet-4-20250514', protocol: 'test' },
    async complete(request): Promise<ModelResponse> {
      step += 1
      captured.push(request)
      if (step === 1) {
        const call = toolCall('huge_output', {})
        if (call.kind !== 'tool') {
          throw new Error('unexpected mock step')
        }
        return {
          text: '',
          toolCalls: [{ id: 'call_1', name: call.name, arguments: call.arguments }],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 },
        }
      }
      return {
        text: 'done',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    },
  }
}

function hugeOutputTool(
  overrides: Partial<Tool<Record<string, never>>> = {},
): Tool<Record<string, never>> {
  return {
    name: 'huge_output',
    description: '输出超长内容',
    inputSchema: z.object({}).strict(),
    sideEffect: 'read',
    async execute() {
      return { ok: true, output: { data: 'x'.repeat(5_000) } }
    },
    ...overrides,
  }
}

const SMALL_BUDGET_POLICY: ContextBudgetPolicy = {
  utilizationThreshold: 0.7,
  estimateCoefficient: 4,
  reserveOutputTokens: 0,
  toolResultBudgetChars: 1_000,
}

function toolMessageOf(captured: ModelRequest[]): string {
  return captured[1]?.messages.find((message) => message.role === 'tool')?.content ?? ''
}

describe('测试套件：工具结果入历史统一裁剪（M1/EX-7）', () => {
  it('验证：超预算工具结果被裁剪为 head+tail 且带截断标记', async () => {
    const captured: ModelRequest[] = []
    const deps = createAgentDeps(
      twoStepModel(captured),
      undefined,
      createSecurityServices(),
      undefined,
      undefined,
      undefined,
      undefined,
      [hugeOutputTool()],
    )
    const runner = new AgentRunner({ ...deps, contextBudget: SMALL_BUDGET_POLICY })
    await runner.run(task, context())

    expect(captured.length).toBe(2)
    const content = toolMessageOf(captured)
    expect(content).toContain('[truncated: 原始 ')
    expect(content).toContain('已截断]')
    expect(content.length).toBeLessThan(1_600)
  })

  it('验证：工具级 resultBudgetChars 覆盖默认预算', async () => {
    const captured: ModelRequest[] = []
    // 工具放宽到 10_000 字符：默认预算 1_000 不再裁剪它。
    const tool = hugeOutputTool({ resultBudgetChars: 10_000 })
    const deps = createAgentDeps(
      twoStepModel(captured),
      undefined,
      createSecurityServices(),
      undefined,
      undefined,
      undefined,
      undefined,
      [tool],
    )
    const runner = new AgentRunner({ ...deps, contextBudget: SMALL_BUDGET_POLICY })
    await runner.run(task, context())

    const content = toolMessageOf(captured)
    expect(content).not.toContain('[truncated')
    expect(content.length).toBeGreaterThan(5_000)
  })

  it('验证：预算关闭（Infinity）时行为与主干一致', async () => {
    const captured: ModelRequest[] = []
    const deps = createAgentDeps(
      twoStepModel(captured),
      undefined,
      createSecurityServices(),
      undefined,
      undefined,
      undefined,
      undefined,
      [hugeOutputTool()],
    )
    const runner = new AgentRunner({
      ...deps,
      contextBudget: { ...SMALL_BUDGET_POLICY, toolResultBudgetChars: Number.POSITIVE_INFINITY },
    })
    await runner.run(task, context())

    expect(toolMessageOf(captured)).not.toContain('[truncated')
  })
})
