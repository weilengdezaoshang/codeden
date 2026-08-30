import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CodeDenError } from '../../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../../core/errors/error-codes.js'
import type { AgentPort } from '../../../eval/ports/agent.port.js'
import { parseTaskSpec } from '../../../core/task/task-spec.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  readOnly: z.boolean().default(true),
})

export interface SubagentToolOptions {
  readonly maxTurns?: number
  readonly maxToolCalls?: number
  readonly maxConcurrent?: number
}

/** Runs a bounded read-only child agent; nested agents cannot recursively spawn more agents. */
export class SubagentTool implements Tool<z.infer<typeof InputSchema>> {
  readonly name = 'subagent'
  readonly description = 'Delegate a focused, bounded subtask to a read-only child agent.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'process' as const

  private readonly maxTurns: number
  private readonly maxToolCalls: number
  private readonly maxConcurrent: number
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(agent: AgentPort, options: SubagentToolOptions = {}) {
    this.agent = agent
    this.maxTurns = positiveLimit(options.maxTurns ?? 3, 'maxTurns')
    this.maxToolCalls = positiveLimit(options.maxToolCalls ?? 6, 'maxToolCalls')
    this.maxConcurrent = positiveLimit(options.maxConcurrent ?? 2, 'maxConcurrent')
  }

  private readonly agent: AgentPort

  async execute(input: z.infer<typeof InputSchema>, context: ToolContext): Promise<unknown> {
    const prompt = input.prompt.trim()
    if (!input.readOnly) {
      throw new CodeDenError({
        code: ErrorCodes.TOOL_PERMISSION_DENIED,
        category: 'permission',
        message: '子 Agent 仅支持只读执行，不能直接修改父任务工作区',
        retryable: false,
      })
    }

    await this.acquire(context.abortSignal)
    try {
      return await this.runChild(prompt, context)
    } finally {
      this.release()
    }
  }

  private async runChild(prompt: string, context: ToolContext): Promise<unknown> {
    const allowedPaths = normalizeAllowedPaths(context.allowedPaths)
    const task = {
      prompt,
      taskSpec: parseTaskSpec({
        id: `subagent-${randomUUID()}`,
        goal: prompt,
        allowedPaths,
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
      limits: { maxTurns: this.maxTurns, maxToolCalls: this.maxToolCalls },
      submissionType: 'text',
      allowedPaths,
      readOnly: true,
      subagentDepth: (context.subagentDepth ?? 0) + 1,
      includeUserInstructions: context.includeUserInstructions,
    })
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw abortError()
    }
    if (this.active < this.maxConcurrent) {
      this.active += 1
      return
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        if (settled) {
          return
        }
        settled = true
        this.removeWaiter(waiter)
        reject(abortError())
      }
      const waiter = () => {
        if (settled) {
          return
        }
        settled = true
        signal?.removeEventListener('abort', onAbort)
        this.active += 1
        resolve()
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    next?.()
  }

  private removeWaiter(waiter: () => void): void {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) {
      this.waiters.splice(index, 1)
    }
  }
}

function normalizeAllowedPaths(paths: readonly string[] | undefined): string[] {
  const normalized = (paths ?? []).map((item) => item.trim()).filter(Boolean)
  return normalized.length > 0 ? [...new Set(normalized)] : ['.']
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function abortError(): Error {
  const error = new Error('子 Agent 等待执行槽位时已取消')
  error.name = 'AbortError'
  return error
}
