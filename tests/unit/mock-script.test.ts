import { describe, expect, it } from 'vitest'
import { CodeDenError } from '../../packages/core/src/errors/codeden-error.js'
import { ErrorCodes } from '../../packages/core/src/errors/error-codes.js'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import type { AgentRunContext } from '../../packages/agent-runtime/src/agent/agent-contracts.js'
import { createAgentRunner } from '../../packages/agent-runtime/src/create-codeden-runtime.js'
import {
  atRound,
  finalText,
  modelError,
  modelHttpError,
  MockModelProvider,
  oversizedText,
} from '../../packages/agent-runtime/src/models/mock-model-provider.js'

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

const task = {
  prompt: '执行任务',
  taskSpec: parseTaskSpec({ id: 't', goal: '执行任务' }),
}

describe('测试套件：Mock 剧本轮次注入（M5）', () => {
  it('验证：未标注轮次的步骤保持 FIFO 顺序', async () => {
    const provider = new MockModelProvider([finalText('一'), finalText('二')])
    await expect(provider.complete({ messages: [], tools: [] })).resolves.toMatchObject({
      text: '一',
    })
    await expect(provider.complete({ messages: [], tools: [] })).resolves.toMatchObject({
      text: '二',
    })
  })

  it('验证：atRound 步骤只在指定轮次生效且不占用 FIFO 顺序', async () => {
    const provider = new MockModelProvider([
      finalText('第一轮'),
      atRound(3, finalText('第三轮特殊')),
      finalText('第二轮'),
    ])
    await expect(provider.complete({ messages: [], tools: [] })).resolves.toMatchObject({
      text: '第一轮',
    })
    await expect(provider.complete({ messages: [], tools: [] })).resolves.toMatchObject({
      text: '第二轮',
    })
    await expect(provider.complete({ messages: [], tools: [] })).resolves.toMatchObject({
      text: '第三轮特殊',
    })
  })

  it('验证：http 错误可重试属性正确标注（EX-1）', () => {
    const throttled = modelHttpError(429)
    if (throttled.kind !== 'error') {
      throw new Error('expected error step')
    }
    expect(throttled.error.retryable).toBe(true)
    const serverError = modelHttpError(503)
    if (serverError.kind !== 'error') {
      throw new Error('expected error step')
    }
    expect(serverError.error.retryable).toBe(true)
    const badRequest = modelHttpError(400)
    if (badRequest.kind !== 'error') {
      throw new Error('expected error step')
    }
    expect(badRequest.error.retryable).toBe(false)
  })

  it('验证：oversizedText 输出超长文本', () => {
    const step = oversizedText(300_000)
    if (step.kind !== 'text') {
      throw new Error('expected text step')
    }
    expect(step.text.length).toBe(300_000)
  })

  it('验证：runner 下第 N 轮注入限流错误后重试恢复（EX-1）', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([atRound(1, modelHttpError(429)), finalText('恢复后完成')]),
    )
    const result = await runner.run(task, context())
    // 第 1 轮限流可重试；重试不消耗额外轮次，重试后正常完成。
    expect(result.status).toBe('submitted')
    expect(result.finalResponse).toBe('恢复后完成')
    expect(result.metrics.modelRequests).toBe(1)
  })

  it('验证：不可重试错误不触发续写也不误判完成', async () => {
    const runner = createAgentRunner(
      new MockModelProvider([
        atRound(
          1,
          modelError(
            new CodeDenError({
              code: ErrorCodes.MODEL_RESPONSE_INVALID,
              category: 'model',
              message: '响应非法',
              retryable: false,
            }),
          ),
        ),
        finalText('不应到达'),
      ]),
    )
    const result = await runner.run(task, context())
    expect(result.status).toBe('agent_error')
    expect(result.finalResponse).not.toBe('不应到达')
  })
})
