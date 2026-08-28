import { describe, expect, it } from 'vitest'
import { zodFromJsonSchema } from '../../../src/runtime/mcp/json-schema.js'

describe('测试套件：MCP JSON Schema 转换', () => {
  it('验证：按类型和必填字段校验工具参数', () => {
    const schema = zodFromJsonSchema({
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
      additionalProperties: false,
    })

    expect(schema.safeParse({ query: 'node', limit: 3 }).success).toBe(true)
    expect(schema.safeParse({ query: 'node' }).success).toBe(true)
    expect(schema.safeParse({ limit: 3 }).success).toBe(false)
    expect(schema.safeParse({ query: 'node', limit: 1.5 }).success).toBe(false)
    expect(schema.safeParse({ query: 'node', extra: true }).success).toBe(false)
  })

  it('验证：未知或缺失 Schema 时仍允许对象参数', () => {
    const schema = zodFromJsonSchema()
    expect(schema.safeParse({ value: 'ok' }).success).toBe(true)
    expect(schema.safeParse('invalid').success).toBe(false)
  })

  it('验证：支持数组和字符串枚举', () => {
    const schema = zodFromJsonSchema({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'safe'] },
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['mode', 'paths'],
    })

    expect(schema.safeParse({ mode: 'fast', paths: ['src'] }).success).toBe(true)
    expect(schema.safeParse({ mode: 'unknown', paths: ['src'] }).success).toBe(false)
  })
})
