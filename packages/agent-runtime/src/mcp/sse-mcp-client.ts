import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { McpClient } from './mcp-client.js'
import type { McpToolDescriptor } from './stdio-mcp-client.js'

export interface SseMcpClientConfig {
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
}

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { message?: string }
}

const MAX_MESSAGE_BYTES = 2_000_000

/** MCP SSE transport client; the GET stream carries notifications and deferred responses. */
export class SseMcpClient implements McpClient {
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private nextId = 1
  private endpoint: URL | undefined
  private controller: AbortController | undefined
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private reading: Promise<void> | undefined
  private endpointWait: Promise<void> | undefined
  private resolveEndpoint: (() => void) | undefined
  private rejectEndpoint: ((error: Error) => void) | undefined
  private initialized = false
  private connecting: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(
    private readonly serverName: string,
    private readonly config: SseMcpClientConfig,
  ) {}

  async connect(): Promise<void> {
    if (this.initialized) {
      return
    }
    if (this.connecting) {
      return this.connecting
    }
    this.connecting = this.start()
    try {
      await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  private async start(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    try {
      const response = await fetch(this.config.url, {
        headers: { Accept: 'text/event-stream', ...this.config.headers },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`SSE MCP server returned HTTP ${response.status}`)
      }
      if (!response.body) {
        throw new Error(`SSE MCP server ${this.serverName} returned an empty stream`)
      }
      this.reader = response.body.getReader()
      this.endpointWait = new Promise<void>((resolve, reject) => {
        this.resolveEndpoint = resolve
        this.rejectEndpoint = reject
      })
      this.reading = this.readStream(controller)
      await withTimeout(this.endpointWait, this.timeoutMs(), `SSE MCP endpoint: ${this.serverName}`)
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codeden', version: '1.0.0' },
      })
      await this.notify('notifications/initialized', {})
      this.initialized = true
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.connect()
    const result = await this.request('tools/list', {})
    return isRecord(result) && Array.isArray(result.tools)
      ? result.tools.filter(isToolDescriptor)
      : []
  }

  async callTool(name: string, arguments_: unknown): Promise<unknown> {
    await this.connect()
    return this.request('tools/call', { name, arguments: arguments_ ?? {} })
  }

  async close(): Promise<void> {
    if (this.closing) {
      return this.closing
    }
    this.closing = this.stop()
    try {
      await this.closing
    } finally {
      this.closing = undefined
    }
  }

  private async stop(): Promise<void> {
    this.initialized = false
    this.controller?.abort()
    this.controller = undefined
    this.rejectEndpoint?.(new Error('SSE MCP client closed'))
    this.resolveEndpoint = undefined
    this.rejectEndpoint = undefined
    this.failPending(new Error('SSE MCP client closed'))
    await this.reader?.cancel().catch(() => undefined)
    await this.reading?.catch(() => undefined)
    this.reader = undefined
    this.reading = undefined
    this.endpointWait = undefined
    this.endpoint = undefined
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const endpoint = this.endpoint
    if (!endpoint) {
      throw new Error(`SSE MCP server ${this.serverName} has not provided an endpoint`)
    }
    const id = this.nextId++
    const timeoutMs = this.timeoutMs()
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new CodeDenError({
            code: ErrorCodes.MODEL_REQUEST_FAILED,
            category: 'tool',
            message: `MCP request timed out: ${method}`,
            retryable: true,
          }),
        )
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: this.controller?.signal,
      })
      if (!response.ok && response.status !== 202) {
        throw new Error(`SSE MCP request returned HTTP ${response.status}`)
      }
      if (response.status === 202) {
        await response.body?.cancel().catch(() => undefined)
      } else {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          this.dispatch(await response.json())
        } else if (response.body) {
          await this.readResponse(response.body)
        }
      }
    } catch (error) {
      this.rejectPending(id, error instanceof Error ? error : new Error(String(error)))
    }
    return result
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const endpoint = this.endpoint
    if (!endpoint) {
      throw new Error(`SSE MCP server ${this.serverName} has not provided an endpoint`)
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: this.controller?.signal,
    })
    if (!response.ok && response.status !== 202) {
      throw new Error(`SSE MCP notification returned HTTP ${response.status}`)
    }
    await response.body?.cancel().catch(() => undefined)
  }

  private async readStream(controller: AbortController): Promise<void> {
    if (!this.reader) {
      return
    }
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await this.reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        assertMessageSize(buffer)
        buffer = this.consumeEvents(buffer)
      }
      buffer += decoder.decode()
      this.consumeEvents(buffer, true)
      if (!controller.signal.aborted) {
        this.disconnect(new Error(`SSE MCP server ${this.serverName} closed the stream`))
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.disconnect(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private disconnect(error: Error): void {
    this.initialized = false
    this.endpoint = undefined
    this.rejectEndpoint?.(error)
    this.failPending(error)
    this.controller?.abort()
    void this.reader?.cancel().catch(() => undefined)
  }

  private async readResponse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        assertMessageSize(buffer)
        buffer = this.consumeEvents(buffer)
      }
      this.consumeEvents(buffer + decoder.decode(), true)
    } finally {
      reader.releaseLock()
    }
  }

  private consumeEvents(input: string, flush = false): string {
    const parts = input.split(/\r?\n\r?\n/u)
    const remainder = flush ? '' : (parts.pop() ?? '')
    for (const part of flush ? parts.concat(remainder) : parts) {
      this.dispatchEvent(part)
    }
    return remainder
  }

  private dispatchEvent(raw: string): void {
    assertMessageSize(raw)
    let event = 'message'
    const data: string[] = []
    for (const line of raw.split(/\r?\n/u)) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        data.push(line.slice('data:'.length).trimStart())
      }
    }
    if (event === 'endpoint' && data.length > 0) {
      try {
        this.endpoint = new URL(data.join('\n'), this.config.url)
        this.resolveEndpoint?.()
        this.resolveEndpoint = undefined
        this.rejectEndpoint = undefined
      } catch (error) {
        this.rejectEndpoint?.(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (data.length === 0) {
      return
    }
    try {
      this.dispatch(JSON.parse(data.join('\n')))
    } catch {
      // Ignore non-JSON SSE comments and server diagnostics.
    }
  }

  private dispatch(message: unknown): void {
    if (!isRecord(message) || typeof message.id !== 'number') {
      return
    }
    const response = message as JsonRpcResponse
    if (response.error) {
      this.rejectPending(message.id, new Error(response.error.message ?? 'MCP request failed'))
    } else {
      this.resolvePending(message.id, response.result)
    }
  }

  private resolvePending(id: number, value: unknown): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(value)
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private timeoutMs(): number {
    return Math.max(100, this.config.timeoutMs ?? 15_000)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CodeDenError({
                code: ErrorCodes.MODEL_REQUEST_FAILED,
                category: 'tool',
                message: `${label} timed out`,
                retryable: true,
              }),
            ),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function isToolDescriptor(value: unknown): value is McpToolDescriptor {
  return isRecord(value) && typeof value.name === 'string'
}

function assertMessageSize(value: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error('MCP response exceeded size limit')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
