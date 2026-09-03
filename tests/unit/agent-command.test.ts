import { describe, expect, it } from 'vitest'
import {
  allowsInteractiveWriteback,
  isSuccessfulAgentResult,
  parsePersonaCommand,
} from '../../apps/agent/src/agent-command.js'

describe('测试套件：parsePersonaCommand', () => {
  it('支持查看、清除和设置人格命令', () => {
    expect(parsePersonaCommand('/persona')).toEqual({ type: 'show' })
    expect(parsePersonaCommand('/persona clear')).toEqual({ type: 'clear' })
    expect(parsePersonaCommand('/persona concise and direct')).toEqual({
      type: 'set',
      value: 'concise and direct',
    })
  })

  it('将空人格视为查看并拒绝相似前缀', () => {
    expect(parsePersonaCommand('/persona   ')).toEqual({ type: 'show' })
    expect(parsePersonaCommand('/personality concise')).toBeUndefined()
    expect(parsePersonaCommand('persona concise')).toBeUndefined()
  })
})

describe('测试套件：交互结果门禁', () => {
  it('只允许已验证完成的结果写回', () => {
    const verifiedSnapshot = {} as never
    expect(allowsInteractiveWriteback({ status: 'verified_complete', verifiedSnapshot })).toBe(true)
    expect(allowsInteractiveWriteback({ status: 'verified_complete' })).toBe(false)
    expect(allowsInteractiveWriteback({ status: 'submitted', verifiedSnapshot })).toBe(false)
  })

  it('将已提交的规划结果和已验证结果视为命令成功', () => {
    expect(isSuccessfulAgentResult('submitted')).toBe(true)
    expect(isSuccessfulAgentResult('verified_complete')).toBe(true)
    expect(isSuccessfulAgentResult('timeout')).toBe(false)
  })
})
