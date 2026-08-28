import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeClock } from '../../src/core/clock.js'
import { CodeDenError } from '../../src/core/errors/codeden-error.js'
import { ErrorCodes } from '../../src/core/errors/error-codes.js'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { parseTaskSpec } from '../../src/core/task/task-spec.js'
import type { AgentRunContext } from '../../src/eval/ports/agent.port.js'
import type { ModelProvider } from '../../src/runtime/models/model-provider.js'
import type { ModelRequest } from '../../src/runtime/models/model-types.js'
import { createAgentRunner } from '../../src/runtime/create-codeden-runtime.js'
import {
  MockModelProvider,
  finalText,
  modelError,
  toolCall,
} from '../../src/runtime/models/mock-model-provider.js'

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
    expect(request?.tools.map((tool) => tool.name)).toEqual(['read_file'])
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
    const result = await runner.run(task, context())
    expect(result.status).toBe('agent_error')
    expect(result.stopReason).toContain('provider down')
  })
})
