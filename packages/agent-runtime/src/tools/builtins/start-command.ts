import { z } from 'zod'
import { pathPolicyOf, redactorOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'
import { BackgroundTaskManager } from '../background-task-manager.js'

const InputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(0).max(86_400_000).default(0),
  description: z.string().trim().max(240).optional(),
})

export type StartCommandInput = z.infer<typeof InputSchema>

export class StartCommandTool implements Tool<StartCommandInput> {
  readonly name = 'start_command'
  readonly description =
    'Start a workspace command in the background and return a taskId. Use get_command_output to inspect it and kill_command to stop it.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'process' as const
  readonly timeoutForInput = () => 15_000

  constructor(private readonly tasks: BackgroundTaskManager) {}

  async execute(input: StartCommandInput, context: ToolContext) {
    context.policy.assertCommandsAllowed()
    pathPolicyOf(context).assertCommand(input.command, input.args)
    const result = await this.tasks.start({
      command: input.command,
      args: input.args,
      workspaceRoot: context.workspaceRoot,
      timeoutMs: input.timeoutMs,
      abortSignal: context.abortSignal,
    })
    return {
      taskId: result.taskId,
      command: result.command,
      args: result.args,
      status: result.status,
      description: input.description,
      stdout: redactorOf(context).redact(result.stdout),
      stderr: redactorOf(context).redact(result.stderr),
      startedAt: result.startedAt,
    }
  }
}
