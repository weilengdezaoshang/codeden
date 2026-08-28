import type { Tool } from '../tools/tool.js'
import { StdioMcpClient, type McpServerConfig } from './stdio-mcp-client.js'
import { SseMcpClient } from './sse-mcp-client.js'
import type { McpClient } from './mcp-client.js'
import type { SecretResolver } from '../../security/secret-resolver.js'
import { zodFromJsonSchema } from './json-schema.js'

export class McpManager {
  private readonly clients = new Map<string, McpClient>()
  private readonly tools: Tool[] = []

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly resolver?: SecretResolver,
  ) {}

  async connectAll(): Promise<Tool[]> {
    if (this.clients.size > 0) {
      return [...this.tools]
    }
    try {
      for (const [serverName, config] of Object.entries(this.servers)) {
        const client =
          config.transport === 'sse'
            ? new SseMcpClient(serverName, {
                url: config.url!,
                headers: this.resolveHeaders(config.headers),
                timeoutMs: config.timeoutMs,
              })
            : new StdioMcpClient(serverName, {
                ...config,
                env: this.resolveEnv(config.env),
              })
        await client.connect()
        this.clients.set(serverName, client)
        for (const descriptor of await client.listTools()) {
          this.tools.push({
            name: `mcp__${serverName}__${descriptor.name}`,
            description: `[MCP ${serverName}] ${descriptor.description ?? descriptor.name}`,
            inputSchema: zodFromJsonSchema(descriptor.inputSchema),
            sideEffect: 'process',
            execute: async (input) => client.callTool(descriptor.name, input),
          })
        }
      }
      return [...this.tools]
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private resolveEnv(env: McpServerConfig['env']): Record<string, string> | undefined {
    if (!env) {
      return undefined
    }
    const resolved: Record<string, string> = {}
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === 'string') {
        resolved[name] = value
      } else {
        if (!this.resolver) {
          throw new Error(`MCP 环境变量 ${name} 需要 SecretResolver`)
        }
        const secret = this.resolver.resolve(value)
        resolved[name] = secret.exposeForTransport()
      }
    }
    return resolved
  }

  private resolveHeaders(headers: McpServerConfig['headers']): Record<string, string> | undefined {
    if (!headers) {
      return undefined
    }
    const resolved: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        resolved[name] = value
      } else {
        if (!this.resolver) {
          throw new Error(`MCP 请求头 ${name} 需要 SecretResolver`)
        }
        resolved[name] = this.resolver.resolve(value).exposeForTransport()
      }
    }
    return resolved
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()))
    this.clients.clear()
    this.tools.length = 0
  }
}
