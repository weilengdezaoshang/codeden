import { afterEach, describe, expect, it } from 'vitest'
import { createModelProvider } from '../../packages/agent-runtime/src/models/create-model-provider.js'

const original = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
}

afterEach(() => {
  restore('DEEPSEEK_API_KEY', original.DEEPSEEK_API_KEY)
  restore('OPENAI_API_KEY', original.OPENAI_API_KEY)
  restore('XAI_API_KEY', original.XAI_API_KEY)
})

describe('测试套件：createModelProvider', () => {
  it('验证：creates a mock provider without any API key', () => {
    expect(createModelProvider('mock').name).toBe('mock-model')
  })

  it('验证：requires DEEPSEEK_API_KEY for --model deepseek', () => {
    delete process.env.DEEPSEEK_API_KEY
    expect(() => createModelProvider('deepseek')).toThrow(/DEEPSEEK_API_KEY/)
  })

  it('验证：creates a deepseek provider when the key is set', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    expect(createModelProvider('deepseek').name).toBe('deepseek')
  })

  it('验证：rejects an unknown model alias', () => {
    expect(() => createModelProvider('claude')).toThrow(/未知模型/)
  })
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}
