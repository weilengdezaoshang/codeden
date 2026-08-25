import { describe, expect, it, vi } from 'vitest'
import type { AgentPort } from '../../src/eval/ports/agent.port.js'
import { AgentSession } from '../../src/runtime/session/agent-session.js'

describe('AgentSession', () => {
  it('串行执行并将上一轮对话传给下一轮', async () => {
    const contexts: unknown[] = []
    const agent = {
      name: 'fake',
      run: vi.fn(async (_task, context) => {
        contexts.push(context.conversation)
        return {
          status: 'submitted' as const,
          finalResponse: 'reply-' + contexts.length,
          metrics: {} as never,
        }
      }),
    } as AgentPort
    const session = new AgentSession(
      agent,
      () => ({}) as never,
      (prompt) => ({ prompt, taskSpec: {} as never }),
      (() => {
        let now = 0
        return () => ++now
      })(),
    )

    await Promise.all([session.submit(' first '), session.submit('second')])

    expect(agent.run).toHaveBeenCalledTimes(2)
    expect(contexts[0]).toEqual([])
    expect(contexts[1]).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
    ])
    expect(session.history).toHaveLength(2)
    session.clearHistory()
    expect(session.history).toHaveLength(0)
    session.close()
    await expect(session.submit('third')).rejects.toThrow('closed')
  })
})
