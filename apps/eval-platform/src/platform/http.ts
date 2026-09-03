import { z } from 'zod'
import { PlatformError, publicError, parseEventCursor, parsePage } from './contracts.js'
import type { Platform } from './service.js'

const id = z.uuid()
const trial = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

/** 浏览器与 CLI 都走同一接口边界。仅支持 loopback 请求。 */
export async function handlePlatformRequest(
  request: Request,
  getPlatform: () => Promise<Platform>,
  origin = 'http://127.0.0.1:3210',
): Promise<Response> {
  try {
    assertLocalRequest(request, origin)
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'api') {
      throw new PlatformError(404, 'NOT_FOUND', '接口不存在。')
    }
    if (request.method === 'GET' && parts.length === 2 && parts[1] === 'catalog') {
      return json(await (await getPlatform()).catalog.view())
    }
    if (parts[1] !== 'jobs') {
      throw new PlatformError(404, 'NOT_FOUND', '接口不存在。')
    }
    if (parts.length === 2 && request.method === 'POST') {
      const body = await readJson(request)
      return json(await (await getPlatform()).create(body), 202)
    }
    if (parts.length === 2 && request.method === 'GET') {
      const page = parsePage(url.searchParams)
      return json({ items: await (await getPlatform()).store.list(page.offset, page.limit) })
    }
    const jobId = id.parse(parts[2])
    if (parts.length === 3 && request.method === 'GET') {
      return json(await (await getPlatform()).store.detail(jobId))
    }
    if (parts.length === 4 && parts[3] === 'cancel' && request.method === 'POST') {
      return json(await (await getPlatform()).store.cancel(jobId))
    }
    if (parts.length === 3 && request.method === 'DELETE') {
      await (await getPlatform()).store.delete(jobId)
      return new Response(null, { status: 204, headers: JSON_HEADERS })
    }
    if (
      parts.length === 6 &&
      parts[3] === 'trials' &&
      parts[5] === 'events' &&
      request.method === 'GET'
    ) {
      const trialId = trial.parse(parts[4])
      const page = parsePage(url.searchParams)
      const afterSequence = parseEventCursor(url.searchParams)
      const benchmarkRunId = url.searchParams.get('benchmarkRunId') ?? undefined
      return json(
        await (
          await getPlatform()
        ).store.eventPage(jobId, trialId, page.offset, page.limit, benchmarkRunId, afterSequence),
      )
    }
    if (
      parts.length === 7 &&
      parts[3] === 'trials' &&
      parts[5] === 'events' &&
      parts[6] === 'stream' &&
      request.method === 'GET'
    ) {
      const trialId = trial.parse(parts[4])
      const cursorValue =
        request.headers.get('last-event-id') ?? url.searchParams.get('afterSequence')
      const cursorParams = new URLSearchParams()
      if (cursorValue !== null) {
        cursorParams.set('afterSequence', cursorValue)
      }
      const afterSequence = parseEventCursor(cursorParams)
      const benchmarkRunId = url.searchParams.get('benchmarkRunId') ?? undefined
      const platform = await getPlatform()
      await platform.store.get(jobId)
      return eventStream(
        platform.store,
        jobId,
        trialId,
        benchmarkRunId,
        afterSequence,
        request.signal,
      )
    }
    throw new PlatformError(
      405,
      'METHOD_NOT_ALLOWED',
      `不支持此操作：${request.method} ${url.pathname}`,
    )
  } catch (error) {
    const safe = publicError(error)
    return json({ error: { code: safe.code, message: safe.message } }, safe.status)
  }
}

function eventStream(
  store: Platform['store'],
  jobId: string,
  trialId: string,
  benchmarkRunId: string | undefined,
  initialSequence: number | undefined,
  signal: AbortSignal,
) {
  const encoder = new TextEncoder()
  let closed = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const run = async () => {
        let cursor = initialSequence ?? -1
        let lastHeartbeat = Date.now()
        try {
          while (!closed && !signal.aborted) {
            const page = await store.eventPage(jobId, trialId, 0, 200, benchmarkRunId, cursor)
            if (page.items.length > 0) {
              for (const event of page.items) {
                controller.enqueue(
                  encoder.encode(
                    `id: ${event.sequence}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`,
                  ),
                )
                cursor = event.sequence
              }
              continue
            }
            if (Date.now() - lastHeartbeat >= 15_000) {
              controller.enqueue(encoder.encode(': heartbeat\n\n'))
              lastHeartbeat = Date.now()
            }
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        } catch (_error) {
          if (!closed && !signal.aborted) {
            controller.enqueue(
              encoder.encode(
                `event: stream-error\ndata: ${JSON.stringify({ message: '事件流暂时不可用。' })}\n\n`,
              ),
            )
          }
        } finally {
          if (!closed) {
            controller.close()
          }
        }
      }
      void run()
    },
    cancel() {
      closed = true
    },
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
export function assertLocalRequest(request: Request, origin: string) {
  const expected = new URL(origin)
  if (!isLoopback(expected.hostname) || expected.protocol !== 'http:') {
    throw new PlatformError(503, 'LOCAL_ONLY', '第一版仅支持本机访问，尚未提供多人认证。')
  }
  const url = new URL(request.url)
  if (!isLoopback(url.hostname) || url.protocol !== 'http:') {
    throw new PlatformError(403, 'ORIGIN_REJECTED', '访问来源不受信任。')
  }
  const host = request.headers.get('host')
  if (host && !isSameLocalHost(host, url)) {
    throw new PlatformError(403, 'ORIGIN_REJECTED', '访问来源不受信任。')
  }
  const source = request.headers.get('origin')
  let sourceUrl: URL | undefined
  if (source) {
    try {
      sourceUrl = new URL(source)
    } catch {
      throw new PlatformError(403, 'ORIGIN_REJECTED', '访问来源不受信任。')
    }
  }
  if (
    (sourceUrl && !isSameLocalOrigin(sourceUrl, url)) ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.method !== 'GET' && !sourceUrl)
  ) {
    throw new PlatformError(403, 'ORIGIN_REJECTED', '访问来源不受信任。')
  }
}
function isLoopback(hostname: string) {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}
function isSameLocalOrigin(left: URL, right: URL) {
  return (
    left.protocol === 'http:' &&
    right.protocol === 'http:' &&
    isLoopback(left.hostname) &&
    isLoopback(right.hostname) &&
    left.port === right.port
  )
}
function isSameLocalHost(host: string, url: URL) {
  try {
    const parsed = new URL(`http://${host}`)
    return isSameLocalOrigin(parsed, url)
  } catch {
    return false
  }
}
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new PlatformError(415, 'JSON_REQUIRED', '请使用 JSON 请求。')
  }
  const reader = request.body?.getReader()
  if (!reader) {
    throw new PlatformError(400, 'EMPTY_BODY', '请求内容不能为空。')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      size += chunk.value.byteLength
      if (size > 8_192) {
        await reader.cancel()
        throw new PlatformError(413, 'BODY_TOO_LARGE', '请求内容过大。')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new PlatformError(400, 'INVALID_JSON', '请求内容不是有效的 JSON。')
  }
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}
