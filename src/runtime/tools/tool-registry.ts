import { z } from 'zod'
import type { ToolDefinition } from '../models/model-types.js'
import type { Tool } from './tool.js'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  definitions(readOnly = false): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => !readOnly || tool.sideEffect === 'read')
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
      }))
  }
}
