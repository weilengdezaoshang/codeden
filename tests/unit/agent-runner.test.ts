import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../src/core/clock.js'
import { CodeDenError } from '../../src/core/errors/codeden-error.js'
import { ErrorCodes } from '../../src/core/errors/error-codes.js'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { parseTaskSpec } from '../../src/core/task/task-spec.js'
import type { AgentRunContext } from '../../src/eval/ports/agent.port.js'
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

describe('AgentRunner', () => {
  it('submits after a direct final reply', async () => {
    const runner = createAgentRunner(new MockModelProvider([finalText('done')]))
    const result = await runner.run(task, context())
    expect(result.status).toBe('submitted')
    expect(result.finalResponse).toBe('done')
    expect(result.submission).toEqual({ type: 'files', changedPaths: ['package.json'] })
    expect(result.metrics.turns).toBe(1)
  })

  it('runs a single tool call then submits', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([toolCall('read_file', { path: 'package.json' }), finalText('read')]),
    )
    const result = await runner.run(task, context())
    expect(result.status).toBe('submitted')
    expect(result.metrics.toolCalls).toBe(1)
    expect(result.metrics.turns).toBe(2)
  })

  it('runs multiple tool rounds', async () => {
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

  it('lets the model recover after a failed tool call', async () => {
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

  it('stops at maxTurns', async () => {
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

  it('stops at maxToolCalls', async () => {
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

  it('treats an aborted provider error as timeout', async () => {
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

  it('maps provider errors to agent_error', async () => {
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
