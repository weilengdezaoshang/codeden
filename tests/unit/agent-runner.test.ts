import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeClock } from '../../packages/core/src/clock.js'
import { CodeDenError } from '../../packages/core/src/errors/codeden-error.js'
import { ErrorCodes } from '../../packages/core/src/errors/error-codes.js'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import type { AgentRunContext } from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import type { ModelProvider } from '../../packages/agent-runtime/src/models/model-provider.js'
import type { ModelRequest } from '../../packages/agent-runtime/src/models/model-types.js'
import { createAgentRunner } from '../../packages/agent-runtime/src/create-codeden-runtime.js'
import {
  MockModelProvider,
  finalText,
  modelError,
  toolCall,
} from '../../packages/agent-runtime/src/models/mock-model-provider.js'

function context(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    runId: 'run',
    trialId: 'trial',
    workspace: {
      root: process.cwd(),
      async changedPaths() {
        return ['package.json']
      },
    },
    eventSink: new NoopEventSink(),
    limits: { maxTurns: 5, maxToolCalls: 5 },
    submissionType: 'files',
    ...overrides,
  }
}

const task = {
  prompt: 'do it',
  taskSpec: parseTaskSpec({ id: 't', goal: 'g' }),
}

describe('测试套件：AgentRunner', () => {
  it('验证：injects workspace instruction hierarchy into the model request', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-agent-'))
    try {
      await writeFile(path.join(root, 'AGENTS.md'), 'Use the repository test command.')
      let request: ModelRequest | undefined
      const provider: ModelProvider = {
        name: 'capture-instructions',
        async complete(input) {
          request = input
          return {
            text: 'done',
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      }
      await createAgentRunner(provider).run(
        task,
        context({
          workspace: {
            root,
            async changedPaths() {
              return []
            },
          },
        }),
      )
      expect(request?.messages[0]?.content).toContain('Use the repository test command.')
      expect(request?.messages[0]?.content).toContain('untrusted project reference material')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证：记录指令来源和冲突诊断但不记录正文', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-agent-'))
    const events: Array<{ type: string; data: unknown }> = []
    try {
      await writeFile(path.join(root, 'AGENTS.md'), 'Use repository rules.')
      await writeFile(path.join(root, 'CLAUDE.md'), 'Use Claude rules.')
      await createAgentRunner({
        name: 'capture-events',
        async complete() {
          return {
            text: 'done',
            toolCalls: [],
            stopReason: 'end_turn' as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      }).run(task, {
        ...context({
          workspace: {
            root,
            async changedPaths() {
              return []
            },
          },
        }),
        eventSink: {
          async emit(type, eventType, data = {}) {
            events.push({ type: eventType, data })
          },
        },
      })
      const loaded = events.find((event) => event.type === 'agent.instructions_loaded')
      expect(loaded?.data).toMatchObject({ conflictCount: 1 })
      expect(JSON.stringify(loaded?.data)).not.toContain('Use repository rules.')
      expect(JSON.stringify(loaded?.data)).not.toContain('Use Claude rules.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('在 Trace 事件中保留用户任务、模型请求和模型返回', async () => {
    const events: Array<{ type: string; data: unknown }> = []
    const runner = createAgentRunner(new MockModelProvider([finalText('trace reply')]))

    await runner.run(task, {
      ...context(),
      eventSink: {
        async emit(_source, type, data) {
          events.push({ type, data })
        },
      },
    })

    expect(events.find((event) => event.type === 'agent.started')?.data).toMatchObject({
      prompt: 'do it',
      taskSpec: { id: 't' },
    })
    expect(events.find((event) => event.type === 'model.requested')?.data).toMatchObject({
      turn: 1,
      messages: expect.any(Array),
      tools: expect.any(Array),
    })
    expect(events.find((event) => event.type === 'model.completed')?.data).toMatchObject({
      text: 'trace reply',
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
    })
  })

  it('验证：instructs the model to research unsupported technical claims', async () => {
    let request: ModelRequest | undefined
    const provider: ModelProvider = {
      name: 'capture',
      async complete(input) {
        request = input
        return {
          text: 'done',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    await createAgentRunner(provider).run(task, context())
    expect(request?.messages[0]?.content).toContain('Do not guess current versions')
    expect(request?.messages[0]?.content).toContain('local code, manifests, lockfiles')
  })

  it('验证：hides write and process tools in plan mode', async () => {
    let request: ModelRequest | undefined
    const provider: ModelProvider = {
      name: 'capture-plan',
      async complete(input) {
        request = input
        return {
          text: 'plan',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    await createAgentRunner(provider).run(task, context({ readOnly: true }))
    expect(request?.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_files',
      'search_files',
      'get_command_output',
      'git_status',
      'git_diff',
      'ask_user',
      'web_search',
      'web_fetch',
      'repo_map',
      'find_symbol',
      'find_references',
      'read_many_files',
    ])
    expect(request?.messages[0]?.content).toContain('Plan mode is enabled')
  })

  it('验证：激活技能时仅向模型暴露技能允许的工具', async () => {
    let request: ModelRequest | undefined
    const provider: ModelProvider = {
      name: 'capture-skill-tools',
      async complete(input) {
        request = input
        return {
          text: 'done',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    await createAgentRunner(provider).run(
      task,
      context({
        activeSkill: 'review',
        skills: [
          {
            name: 'review',
            description: '审查',
            allowedTools: ['read_file'],
            userInvocable: true,
            prompt: '只读审查',
            source: 'project',
            filePath: '.codeden/skills/review/SKILL.md',
          },
        ],
      }),
    )
    expect(request?.tools.map((tool) => tool.name)).toEqual(['read_file'])
  })

  it('验证：Provider 禁用工具能力时不向模型暴露工具', async () => {
    let request: ModelRequest | undefined
    const provider: ModelProvider = {
      name: 'tools-disabled',
      async complete(input) {
        request = input
        return {
          text: 'done',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    await createAgentRunner(
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      false,
    ).run(task, context())
    expect(request?.tools).toEqual([])
  })

  it('验证：Provider 禁用工具能力时拒绝执行模型返回的工具调用', async () => {
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      name: 'tools-disabled-response',
      async complete(input) {
        requests.push(input)
        return requests.length === 1
          ? {
              text: '',
              toolCalls: [
                { id: 'unexpected', name: 'read_file', arguments: { path: 'package.json' } },
              ],
              stopReason: 'tool_use' as const,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          : {
              text: 'done',
              toolCalls: [],
              stopReason: 'end_turn' as const,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
      },
    }
    const result = await createAgentRunner(
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      false,
    ).run(task, context())
    expect(result.status).toBe('submitted')
    expect(result.metrics.toolCalls).toBe(0)
    expect(requests[0]?.tools).toEqual([])
    expect(requests[1]?.messages).toContainEqual({ role: 'assistant', content: '' })
  })

  it('验证：skips command-based verification in plan mode', async () => {
    const verify = vi.fn(async () => ({ passed: true, message: 'ok', evidence: [] }))
    const runner = createAgentRunner(
      new MockModelProvider([finalText('plan')]),
      undefined,
      undefined,
      { verify },
    )
    const result = await runner.run(task, context({ readOnly: true }))
    expect(result.status).toBe('submitted')
    expect(verify).not.toHaveBeenCalled()
  })

  it('使用本轮上下文的验证器判定任务完成', async () => {
    const verify = vi.fn(async () => ({ passed: true, message: 'ok', evidence: [] }))
    const runner = createAgentRunner(new MockModelProvider([finalText('done')]))

    const result = await runner.run(task, context({ completionVerifier: { verify } }))

    expect(result.status).toBe('verified_complete')
    expect(verify).toHaveBeenCalledOnce()
  })

  it('本轮验证器覆盖运行时默认验证器', async () => {
    const defaultVerify = vi.fn(async () => ({ passed: false, message: 'fail', evidence: [] }))
    const turnVerify = vi.fn(async () => ({ passed: true, message: 'ok', evidence: [] }))
    const runner = createAgentRunner(
      new MockModelProvider([finalText('done')]),
      undefined,
      undefined,
      { verify: defaultVerify },
    )

    const result = await runner.run(task, context({ completionVerifier: { verify: turnVerify } }))

    expect(result.status).toBe('verified_complete')
    expect(turnVerify).toHaveBeenCalledOnce()
    expect(defaultVerify).not.toHaveBeenCalled()
  })

  it('将验证器产生的工作区快照返回给写回阶段', async () => {
    const verifiedSnapshot = { attemptId: 'attempt-1' } as never
    const runner = createAgentRunner(
      new MockModelProvider([finalText('done')]),
      undefined,
      undefined,
      {
        async verify() {
          return { passed: true, message: 'ok', evidence: [], verifiedSnapshot }
        },
      },
    )

    const result = await runner.run(task, context())

    expect(result.status).toBe('verified_complete')
    expect(result.verifiedSnapshot).toBe(verifiedSnapshot)
  })

  it('在执行结果中返回结构化验证步骤', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([finalText('done')]),
      undefined,
      undefined,
      {
        async verify() {
          return {
            passed: true,
            message: 'ok',
            evidence: [],
            stepResults: [
              {
                stepId: 'workspace-diff',
                kind: 'diff',
                status: 'passed',
                required: true,
                durationMs: 1,
                message: 'ok',
                evidence: [],
              },
            ],
          }
        },
      },
    )

    const result = await runner.run(task, context())

    expect(result.verification?.stepResults).toEqual([
      expect.objectContaining({ stepId: 'workspace-diff', status: 'passed' }),
    ])
  })

  it('验证：submits after a direct final reply', async () => {
    const runner = createAgentRunner(new MockModelProvider([finalText('done')]))
    const result = await runner.run(task, context())
    expect(result.status).toBe('submitted')
    expect(result.finalResponse).toBe('done')
    expect(result.submission).toEqual({ type: 'files', changedPaths: ['package.json'] })
    expect(result.metrics.turns).toBe(1)
  })

  it('验证：runs a single tool call then submits', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([toolCall('read_file', { path: 'package.json' }), finalText('read')]),
    )
    const result = await runner.run(task, context())
    expect(result.status).toBe('submitted')
    expect(result.metrics.toolCalls).toBe(1)
    expect(result.metrics.turns).toBe(2)
  })

  it('验证：拒绝有副作用的工具后立即停止，不重试命令', async () => {
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      name: 'permission-denied',
      async complete(request) {
        requests.push(request)
        return {
          text: '',
          toolCalls: [
            {
              id: 'command-1',
              name: 'run_command',
              arguments: { command: 'pnpm', args: ['install'] },
            },
          ],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }

    const result = await createAgentRunner(provider).run(
      task,
      context({
        confirmTool: async () => false,
      }),
    )

    expect(result.status).toBe('agent_error')
    expect(result.stopReason).toContain('Tool execution was denied: run_command')
    expect(requests).toHaveLength(1)
    expect(result.metrics.toolCalls).toBe(0)
  })

  it('验证：runs multiple tool rounds', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([
        toolCall('read_file', { path: 'package.json' }),
        toolCall('read_file', { path: 'package.json' }),
        finalText('done'),
      ]),
    )
    const result = await runner.run(task, context())
    expect(result.metrics.turns).toBe(3)
    expect(result.metrics.toolCalls).toBe(2)
  })

  it('验证：lets the model recover after a failed tool call', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([
        toolCall('read_file', { path: '../secret' }),
        toolCall('read_file', { path: 'package.json' }),
        finalText('recovered'),
      ]),
    )
    const result = await runner.run(task, context())
    expect(result.status).toBe('submitted')
    expect(result.metrics.toolFailures).toBeGreaterThan(0)
  })

  it('验证：stops at maxTurns', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([
        toolCall('read_file', { path: 'package.json' }),
        toolCall('read_file', { path: 'package.json' }),
        finalText('late'),
      ]),
    )
    const result = await runner.run(task, context({ limits: { maxTurns: 1, maxToolCalls: 10 } }))
    expect(result.status).toBe('budget_exhausted')
    expect(result.stopReason).toBe('maxTurns')
  })

  it('验证：stops at maxToolCalls', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([
        toolCall('read_file', { path: 'package.json' }),
        toolCall('read_file', { path: 'package.json' }),
        finalText('late'),
      ]),
    )
    const result = await runner.run(task, context({ limits: { maxTurns: 5, maxToolCalls: 1 } }))
    expect(result.status).toBe('budget_exhausted')
    expect(result.stopReason).toBe('maxToolCalls')
  })

  it('验证：连续重复相同工具调用时触发熔断', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([
        toolCall('read_file', { path: 'package.json' }),
        toolCall('read_file', { path: 'package.json' }),
        toolCall('read_file', { path: 'package.json' }),
      ]),
    )

    const result = await runner.run(task, context({ limits: { maxTurns: 8, maxToolCalls: 8 } }))

    expect(result.status).toBe('budget_exhausted')
    expect(result.stopReason).toBe('repeatedToolCall')
  })

  it('验证：交替重复的工具调用同样触发熔断并补齐占位结果', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([
        toolCall('read_file', { path: 'a.txt' }),
        toolCall('list_files', {}),
        toolCall('read_file', { path: 'a.txt' }),
        toolCall('list_files', {}),
        toolCall('read_file', { path: 'a.txt' }),
      ]),
    )

    const result = await runner.run(task, context({ limits: { maxTurns: 8, maxToolCalls: 8 } }))

    expect(result.status).toBe('budget_exhausted')
    expect(result.stopReason).toBe('repeatedToolCall')
    const toolMessages = (result.turnTranscript ?? []).filter((item) => item.role === 'tool')
    expect(toolMessages.length).toBeGreaterThanOrEqual(4)
  })

  it('验证：预算耗尽中断时为未执行的调用补齐占位工具结果', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([
        toolCall('read_file', { path: 'one.txt' }),
        toolCall('read_file', { path: 'two.txt' }),
        finalText('late'),
      ]),
    )

    const result = await runner.run(task, context({ limits: { maxTurns: 5, maxToolCalls: 1 } }))

    expect(result.status).toBe('budget_exhausted')
    expect(result.stopReason).toBe('maxToolCalls')
    const toolMessages = (result.turnTranscript ?? []).filter((item) => item.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages[1]?.content).toContain('AGENT_STOPPED')
  })

  it('验证：可重试的模型错误按退避重试后成功', async () => {
    let calls = 0
    const provider: ModelProvider = {
      name: 'flaky',
      async complete() {
        calls += 1
        if (calls === 1) {
          throw new CodeDenError({
            code: ErrorCodes.MODEL_REQUEST_FAILED,
            category: 'model',
            message: 'rate limited',
            retryable: true,
          })
        }
        return {
          text: 'ok',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const runner = createAgentRunner(provider)

    const result = await runner.run(task, context())

    expect(result.status).toBe('submitted')
    expect(calls).toBe(2)
  })

  it('验证：不可重试的模型错误不触发重试', async () => {
    let calls = 0
    const provider: ModelProvider = {
      name: 'strict',
      async complete() {
        calls += 1
        throw new CodeDenError({
          code: ErrorCodes.MODEL_REQUEST_FAILED,
          category: 'model',
          message: 'bad request',
          retryable: false,
        })
      },
    }
    const runner = createAgentRunner(provider)

    const result = await runner.run(task, context())

    expect(result.status).toBe('agent_error')
    expect(calls).toBe(1)
  })

  it('验证：runTimeoutMs 超时后以 timeout 收口', async () => {
    const provider: ModelProvider = {
      name: 'slow',
      async complete(request) {
        await new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('deadline never fired')), 5_000)
          request.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true },
          )
        })
        throw new Error('unreachable')
      },
    }
    const runner = createAgentRunner(provider)

    const result = await runner.run(
      task,
      context({ limits: { maxTurns: 5, maxToolCalls: 5, runTimeoutMs: 50 } }),
    )

    expect(result.status).toBe('timeout')
  })

  it('验证：treats an aborted provider error as timeout', async () => {
    const controller = new AbortController()
    controller.abort()
    const runner = createAgentRunner(
      new MockModelProvider([
        modelError(
          new CodeDenError({
            code: ErrorCodes.MODEL_REQUEST_FAILED,
            category: 'model',
            message: 'aborted request',
            retryable: false,
          }),
        ),
      ]),
    )
    const result = await runner.run(task, context({ abortSignal: controller.signal }))
    expect(result.status).toBe('timeout')
  })

  it('验证：returns verified_complete only after the verifier passes', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([finalText('done')]),
      undefined,
      undefined,
      {
        async verify() {
          return { passed: true, message: 'ok', evidence: [] }
        },
      },
    )
    const result = await runner.run(task, context())
    expect(result.status).toBe('verified_complete')
  })

  it('验证：does not treat a failed verification as success', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([finalText('done')]),
      undefined,
      undefined,
      {
        async verify() {
          return { passed: false, message: 'no', evidence: ['empty'] }
        },
      },
    )
    const result = await runner.run(task, context({ limits: { maxTurns: 1, maxToolCalls: 5 } }))
    expect(result.status).toBe('budget_exhausted')
    expect(result.status).not.toBe('verified_complete')
  })

  it('验证：maps provider errors to agent_error', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([
        modelError(
          new CodeDenError({
            code: ErrorCodes.MODEL_REQUEST_FAILED,
            category: 'model',
            message: 'provider down',
            retryable: true,
          }),
        ),
      ]),
      new FakeClock(),
    )
    const result = await runner.run(
      task,
      context({ limits: { maxTurns: 5, maxToolCalls: 5, modelRetries: 0 } }),
    )
    expect(result.status).toBe('agent_error')
    expect(result.stopReason).toContain('provider down')
  })
})
