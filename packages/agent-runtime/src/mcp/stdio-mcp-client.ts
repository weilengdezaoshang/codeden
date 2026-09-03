import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { SecretReference } from '@codeden/core/security/secret-reference.js'
import type { McpClient } from './mcp-client.js'

export interface McpServerConfig {
  transport?: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string | SecretReference>
  url?: string
  headers?: Record<string, string | SecretReference>
  cwd?: string
  timeoutMs?: number
}

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const MAX_MESSAGE_BYTES = 2_000_000

/** Minimal MCP stdio JSON-RPC client with bounded requests and explicit lifecycle. */
export class StdioMcpClient implements McpClient {
  private process: ChildProcessWithoutNullStreams | undefined
  private lines: Interface | undefined
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private initialized = false
  private connecting: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
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
    if (!this.config.command) {
      throw new Error(`MCP server ${this.serverName} 缺少 stdio command`)
    }
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { PATH: process.env.PATH ?? '', ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = child
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
    child.on('error', (error) => this.failPending(error))
    child.on('exit', (_code, signal) => {
      if (this.process === child) {
        this.process = undefined
        this.initialized = false
        this.lines?.close()
        this.lines = undefined
      }
      this.failPending(new Error(`MCP server exited (${signal ?? 'unknown'})`))
    })
    child.stderr.resume()
    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codeden', version: '1.0.0' },
      })
      this.notify('notifications/initialized', {})
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
    if (!this.initialized) {
      await this.connect()
    }
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
    this.lines?.close()
    this.lines = undefined
    const child = this.process
    this.process = undefined
    this.initialized = false
    this.failPending(new Error('MCP client closed'))
    if (!child) {
      return
    }
    if (!child.killed) {
      child.kill('SIGTERM')
    }
    await waitForExit(child, 1_000)
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.process
    if (!child?.stdin.writable) {
      return Promise.reject(new Error(`MCP server ${this.serverName} is not running`))
    }
    const id = this.nextId++
    const timeoutMs = Math.max(100, this.config.timeoutMs ?? 15_000)
    return new Promise((resolve, reject) => {
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
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    if (this.process?.stdin.writable) {
      try {
        this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
      } catch (error) {
        this.failPending(error instanceof Error ? error : new Error(String(error)))
        void this.close()
      }
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
      this.failPending(new Error('MCP response exceeded size limit'))
      void this.close()
      return
    }
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }
    if (typeof message.id !== 'number') {
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    this.pending.delete(message.id)
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'MCP request failed'))
    } else {
      pending.resolve(message.result)
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', finish)
      child.removeListener('error', finish)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may have exited between the timeout check and the kill.
      }
      finish()
    }, timeoutMs)
    child.once('exit', finish)
    child.once('error', finish)
  })
}

function isToolDescriptor(value: unknown): value is McpToolDescriptor {
  return isRecord(value) && typeof value.name === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
