import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentPort } from '../../../eval/ports/agent.port.js'
import { parseTaskSpec } from '../../../core/task/task-spec.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  readOnly: z.boolean().default(true),
})

/** Runs a bounded nested agent; nested agents cannot recursively spawn more agents. */
export class SubagentTool implements Tool<z.infer<typeof InputSchema>> {
  readonly name = 'subagent'
  readonly description = 'Delegate a focused, bounded subtask to a read-only child agent.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'process' as const

  constructor(private readonly agent: AgentPort) {}

  async execute(input: z.infer<typeof InputSchema>, context: ToolContext): Promise<unknown> {
    const prompt = input.prompt.trim()
    const task = {
      prompt,
      taskSpec: parseTaskSpec({
        id: `subagent-${randomUUID()}`,
        goal: prompt,
        allowedPaths: ['.'],
      }),
    }
    return this.agent.run(task, {
      runId: `subagent-${randomUUID()}`,
      trialId: `subagent-${randomUUID()}`,
      workspace: {
        root: context.workspaceRoot,
        async changedPaths() {
          return []
        },
      },
      eventSink: context.eventSink,
      abortSignal: context.abortSignal,
      limits: { maxTurns: 3, maxToolCalls: 6 },
      submissionType: 'text',
      allowedPaths: ['.'],
      readOnly: input.readOnly,
      subagentDepth: (context.subagentDepth ?? 0) + 1,
    })
  }
}
