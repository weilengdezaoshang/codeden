import type { McpToolDescriptor } from './stdio-mcp-client.js'

export interface McpClient {
  connect(): Promise<void>
  listTools(): Promise<McpToolDescriptor[]>
  callTool(name: string, arguments_: unknown): Promise<unknown>
  close(): Promise<void>
}
