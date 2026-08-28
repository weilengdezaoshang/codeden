import { describe, expect, it } from 'vitest'
import { ResearchPolicy } from '../../src/runtime/research/research-policy.js'

describe('测试套件：ResearchPolicy', () => {
  const policy = new ResearchPolicy()

  it('验证：requires evidence for current or version-sensitive tasks', () => {
    expect(policy.assess('使用当前最新版本的 Node.js API').level).toBe('required')
    expect(policy.assess('check compatibility with version 24').level).toBe('required')
  })

  it('验证：recommends research when the task has no deterministic trigger', () => {
    expect(policy.assess('重构这个函数').level).toBe('recommended')
  })
})
