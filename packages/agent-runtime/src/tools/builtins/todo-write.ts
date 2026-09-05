import { z } from 'zod'
import type { Tool, ToolContext } from '../tool.js'

const TodoSchema = z.object({
  id: z.string().min(1).max(100),
  content: z.string().trim().min(1).max(500),
  status: z.enum(['pending', 'in_progress', 'completed']),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
})
const InputSchema = z.object({ todos: z.array(TodoSchema).max(100) })
export type TodoWriteInput = z.infer<typeof InputSchema>
export type TodoItem = z.infer<typeof TodoSchema>

export class TodoWriteTool implements Tool<TodoWriteInput> {
  readonly name = 'todo_write'
  readonly description =
    'Create or replace the current task plan with a list of progress-tracked todos.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'write' as const
  /** 待办只保存在任务内存中，不触碰工作区文件，无需逐次审批。 */
  readonly approvalExempt = true as const
  private readonly todos = new Map<string, TodoItem[]>()

  async execute(input: TodoWriteInput, context: ToolContext) {
    const ids = new Set<string>()
    for (const todo of input.todos) {
      if (ids.has(todo.id)) {
        throw new Error(`Duplicate todo id: ${todo.id}`)
      }
      ids.add(todo.id)
    }
    const todos = input.todos.map((todo) => ({ ...todo }))
    this.todos.set(context.workspaceRoot, todos)
    return {
      todos,
      completed: todos.filter((todo) => todo.status === 'completed').length,
      total: todos.length,
    }
  }

  current(workspaceRoot: string): TodoItem[] {
    return (this.todos.get(workspaceRoot) ?? []).map((todo) => ({ ...todo }))
  }
}
