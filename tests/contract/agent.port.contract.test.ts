import { describe, expect, it } from 'vitest'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import { AgentRunResultSchema } from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import { createCodeDenAgent } from '../../packages/agent-runtime/src/create-codeden-runtime.js'
import {
  MockModelProvider,
  finalText,
} from '../../packages/agent-runtime/src/models/mock-model-provider.js'

describe('AgentPort contract', () => {
  it('always returns a valid AgentRunResult and never sets resolved', async () => {
    const agent = createCodeDenAgent(new MockModelProvider([finalText('done')]))
    const result = await agent.run(
      { prompt: 'hello', taskSpec: parseTaskSpec({ id: 't', goal: 'g' }) },
      {
        runId: 'r',
        trialId: 't',
        workspace: { root: process.cwd(), changedPaths: async () => [] },
        eventSink: new NoopEventSink(),
        limits: { maxTurns: 3, maxToolCalls: 3 },
        submissionType: 'text',
      },
    )
    expect(AgentRunResultSchema.parse(result).status).toBe('submitted')
    expect(result).not.toHaveProperty('resolved')
  })

  it('distinguishes timeout from ordinary errors', async () => {
    const agent = createCodeDenAgent({
      name: 'hang',
      complete: () => new Promise(() => undefined),
    })
    const controller = new AbortController()
    controller.abort()
    const result = await agent.run(
      { prompt: 'hello', taskSpec: parseTaskSpec({ id: 't', goal: 'g' }) },
      {
        runId: 'r',
        trialId: 't',
        workspace: { root: process.cwd(), changedPaths: async () => [] },
        eventSink: new NoopEventSink(),
        abortSignal: controller.signal,
        limits: { maxTurns: 3, maxToolCalls: 3 },
        submissionType: 'text',
      },
    )
    expect(result.status).toBe('timeout')
  })
})
