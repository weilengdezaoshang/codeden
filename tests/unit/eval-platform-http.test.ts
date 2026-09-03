import { describe, expect, it, vi } from 'vitest'
import { handlePlatformRequest } from '../../apps/eval-platform/src/platform/http.js'
import type { Platform } from '../../apps/eval-platform/src/platform/service.js'

const origin = 'http://127.0.0.1:3210'
describe('评测平台 HTTP 安全边界', () => {
  it('拒绝跨站、伪造 Host 和非本机部署且不连接数据库', async () => {
    const get = vi.fn()
    for (const headers of [
      { origin: 'https://evil.example' },
      { host: 'evil.example' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await handlePlatformRequest(
        new Request(`${origin}/api/jobs`, { headers }),
        get,
      )
      expect(response.status).toBe(403)
    }
    expect(
      (
        await handlePlatformRequest(
          new Request('http://public.example/api/jobs'),
          get,
          'http://public.example',
        )
      ).status,
    ).toBe(503)
    expect(get).not.toHaveBeenCalled()
  })
  it('允许 Next 在 localhost 与 127.0.0.1 之间规范化请求地址', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'job', status: 'queued' })
    const get = async () => ({ create }) as unknown as Platform
    const response = await handlePlatformRequest(
      new Request('http://127.0.0.1:3000/api/jobs', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      get,
      origin,
    )
    expect(response.status).toBe(202)
  })
  it('创建任务要求同源 JSON，请求过大或格式损坏时不执行', async () => {
    const get = vi.fn()
    const cases = [
      { body: '{}', headers: {}, status: 403 },
      { body: '{}', headers: { origin }, status: 415 },
      { body: '{bad', headers: { origin, 'content-type': 'application/json' }, status: 400 },
      {
        body: 'x'.repeat(8193),
        headers: { origin, 'content-type': 'application/json' },
        status: 413,
      },
    ]
    for (const item of cases) {
      expect(
        (
          await handlePlatformRequest(
            new Request(`${origin}/api/jobs`, {
              method: 'POST',
              headers: item.headers,
              body: item.body,
            }),
            get,
          )
        ).status,
      ).toBe(item.status)
    }
    expect(get).not.toHaveBeenCalled()
  })
  it('无效任务编号和分页在数据库查询前被拒绝', async () => {
    const get = vi.fn()
    for (const suffix of ['/jobs/invalid', '/jobs?limit=500']) {
      expect((await handlePlatformRequest(new Request(`${origin}/api${suffix}`), get)).status).toBe(
        400,
      )
    }
    expect(get).not.toHaveBeenCalled()
  })
  it('创建立即返回任务编号，错误不泄漏内部信息且响应不缓存', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'job', status: 'queued' })
    const get = async () => ({ create }) as unknown as Platform
    const request = () =>
      new Request(`${origin}/api/jobs`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: '{}',
      })
    const response = await handlePlatformRequest(request(), get)
    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ id: 'job', status: 'queued' })
    const failed = await handlePlatformRequest(request(), async () => {
      throw new Error('private-database-password')
    })
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('private-database-password')
  })
})
