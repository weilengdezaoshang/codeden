import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import type { SecretReference } from '../../security/secret-reference.js'

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string | SecretReference>
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
export class StdioMcpClient {
  private process: ChildProcessWithoutNullStreams | undefined
  private lines: Interface | undefined
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private initialized = false

  constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
  ) {}

  async connect(): Promise<void> {
    if (this.process) {
      return
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
    child.on('exit', (_code, signal) =>
      this.failPending(new Error(`MCP server exited (${signal ?? 'unknown'})`)),
    )
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
    this.lines?.close()
    this.lines = undefined
    const child = this.process
    this.process = undefined
    this.initialized = false
    this.failPending(new Error('MCP client closed'))
    if (child && !child.killed) {
      child.kill()
    }
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
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  private notify(method: string, params: unknown): void {
    if (this.process?.stdin.writable) {
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
      return this.failPending(new Error('MCP response exceeded size limit'))
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

function isToolDescriptor(value: unknown): value is McpToolDescriptor {
  return isRecord(value) && typeof value.name === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
