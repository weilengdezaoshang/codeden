import { z } from 'zod'
import { pathPolicyOf, redactorOf } from '../tool-security.js'
import type { SandboxRunner } from '../../sandbox/sandbox-runner.js'
import { createSandboxRunner } from '../../sandbox/sandbox-runner-factory.js'
import type { SandboxRunnerOptions } from '../../sandbox/sandbox-runner-factory.js'
import type { Tool, ToolContext } from '../tool.js'

export const RunPythonInputSchema = z.object({
  script: z.string().min(1).describe('Path to a Python script relative to the workspace root.'),
  args: z.array(z.string()).default([]).describe('Arguments passed to the Python script.'),
  timeoutMs: z.number().int().positive().default(10_000),
})

export type RunPythonInput = z.infer<typeof RunPythonInputSchema>

export interface RunPythonOptions extends SandboxRunnerOptions {
  /** Python executable resolved through PATH, or an explicitly configured path. */
  interpreter?: string
}

/** Execute a workspace Python script without invoking a shell. */
export class RunPythonTool implements Tool<RunPythonInput> {
  readonly name = 'run_python'
  readonly description =
    'Run a Python script from the workspace without a shell. The script path must stay inside the workspace; stdout and stderr are returned separately.'
  readonly inputSchema = RunPythonInputSchema
  readonly sideEffect = 'process' as const
  readonly timeoutForInput = (input: RunPythonInput) =>
    Math.min(Math.max(input.timeoutMs + 5_000, 15_000), 600_000)

  private readonly sandboxRunner: SandboxRunner
  private readonly interpreter: string

  constructor(private readonly options: RunPythonOptions = {}) {
    this.sandboxRunner = createSandboxRunner(options)!
    this.interpreter = options.interpreter ?? defaultPythonInterpreter()
  }

  async execute(input: RunPythonInput, context: ToolContext) {
    context.policy.assertCommandsAllowed()
    pathPolicyOf(context).assertReadable(input.script)
    const scriptPath = await context.policy.resolveReadable(input.script)
    pathPolicyOf(context).assertCommand(this.interpreter, [scriptPath, ...input.args])

    const result = await this.sandboxRunner.run(
      {
        command: this.interpreter,
        args: [scriptPath, ...input.args],
        timeoutMs: input.timeoutMs,
      },
      {
        workspaceRoot: context.workspaceRoot,
        abortSignal: context.abortSignal,
        redact: (value) => redactorOf(context).redact(value),
      },
    )

    return {
      script: input.script,
      interpreter: this.interpreter,
      ...result,
    }
  }
}

function defaultPythonInterpreter(): string {
  return process.platform === 'win32' ? 'python' : 'python3'
}
