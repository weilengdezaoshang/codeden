import { describe, expect, it } from 'vitest'
import {
  createAgentAttempt,
  recordAttemptRevision,
  transitionAttempt,
} from '../../packages/agent-runtime/src/attempts/agent-attempt.js'

function createAttempt() {
  return createAgentAttempt({
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    turnIndex: 1,
    taskSpecVersion: 'task-v1',
    initialRevision: 'a'.repeat(64),
    now: new Date('2026-08-29T00:00:00.000Z'),
  })
}

describe('测试套件：Agent 执行尝试', () => {
  it('验证：按照完成与验证流程推进状态', () => {
    const proposed = transitionAttempt(createAttempt(), 'completion_proposed')
    const verifying = transitionAttempt(proposed, 'verifying')
    const verified = transitionAttempt(verifying, 'verified', {
      verifiedRevision: verifying.currentRevision,
    })
    const ready = transitionAttempt(verified, 'writeback_ready')

    expect(ready.state).toBe('writeback_ready')
    expect(ready.verifiedRevision).toBe(ready.currentRevision)
  })

  it('验证：拒绝不合法的状态跳转', () => {
    expect(() => transitionAttempt(createAttempt(), 'applied')).toThrow(
      'Invalid attempt transition: running -> applied',
    )
  })

  it('验证：验证后工作区变化会使结果过期', () => {
    const proposed = transitionAttempt(createAttempt(), 'completion_proposed')
    const verifying = transitionAttempt(proposed, 'verifying')
    const verified = transitionAttempt(verifying, 'verified', {
      verifiedRevision: verifying.currentRevision,
    })

    const changed = recordAttemptRevision(verified, 'b'.repeat(64))

    expect(changed.state).toBe('stale')
    expect(changed.currentRevision).toBe('b'.repeat(64))
    expect(changed.verifiedRevision).toBeUndefined()
  })

  it('验证：运行中的正常文件变化不会错误标记为过期', () => {
    const changed = recordAttemptRevision(createAttempt(), 'b'.repeat(64))

    expect(changed.state).toBe('running')
    expect(changed.currentRevision).toBe('b'.repeat(64))
  })

  it('验证：验证通过时必须绑定当前工作区版本', () => {
    const proposed = transitionAttempt(createAttempt(), 'completion_proposed')
    const verifying = transitionAttempt(proposed, 'verifying')

    expect(() =>
      transitionAttempt(verifying, 'verified', { verifiedRevision: 'b'.repeat(64) }),
    ).toThrow('Verified revision must match the current workspace revision')
  })

  it('验证：拒绝缺少有效验证版本的持久化状态', () => {
    const attempt = createAttempt()

    expect(() =>
      transitionAttempt(
        {
          ...attempt,
          state: 'verified',
        },
        'writeback_ready',
      ),
    ).toThrow('Attempt does not have a current verified workspace revision')
  })

  it('验证：已结束的执行尝试不能再记录工作区变化', () => {
    const failed = transitionAttempt(createAttempt(), 'failed')

    expect(() => recordAttemptRevision(failed, 'b'.repeat(64))).toThrow(
      'Cannot update a terminal attempt revision',
    )
  })
})
