import { describe, expect, it } from 'vitest'
import {
  CreateJobSchema,
  parsePage,
  publicError,
} from '../../apps/eval-platform/src/platform/contracts.js'

describe('评测平台接口边界', () => {
  it('默认不授权付费模型并拒绝任意路径及命令', () => {
    const input = { datasetId: 'regression', modelId: 'mock', requestId: crypto.randomUUID() }
    expect(CreateJobSchema.parse(input).allowPaid).toBe(false)
    expect(() => CreateJobSchema.parse({ ...input, command: 'echo unsafe' })).toThrow()
    expect(() => CreateJobSchema.parse({ ...input, datasetPath: '/tmp/a' })).toThrow()
  })
  it('支持一个 Job 声明多个并行评测集并拒绝重复评测集', () => {
    const input = {
      datasetId: 'regression',
      datasetIds: ['regression', 'persona'],
      modelId: 'mock',
      requestId: crypto.randomUUID(),
    }
    expect(CreateJobSchema.parse(input).datasetIds).toEqual(['regression', 'persona'])
    expect(() =>
      CreateJobSchema.parse({ ...input, datasetIds: ['regression', 'regression'] }),
    ).toThrow()
    expect(() => CreateJobSchema.parse({ ...input, datasetIds: ['persona'] })).toThrow()
  })
  it('拒绝无效请求编号、空评测集和过大的分页', () => {
    expect(() =>
      CreateJobSchema.parse({ datasetId: '', modelId: 'mock', requestId: 'x' }),
    ).toThrow()
    expect(parsePage(new URLSearchParams())).toEqual({ offset: 0, limit: 30 })
    for (const query of ['offset=-1', 'limit=0', 'limit=201', 'offset=1.5', 'limit=abc']) {
      expect(() => parsePage(new URLSearchParams(query))).toThrow()
    }
  })
  it('未知错误不向浏览器暴露内部消息和密钥', () => {
    expect(publicError(new Error('postgres://private-host/internal'))).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: '服务暂时不可用，请稍后重试。',
    })
  })
})
