import { z } from 'zod'
import { pathPolicyOf, redactorOf } from '../../../security/tool-security.js'
import type { Tool, ToolContext } from '../tool.js'
import type { SandboxRunner } from '../../sandbox/sandbox-runner.js'
import { DockerSandboxRunner } from '../../sandbox/docker-sandbox-runner.js'
import { HostSandboxRunner } from '../../sandbox/host-sandbox-runner.js'

export type CommandSandboxMode = 'host' | 'docker'

export interface RunCommandOptions {
  mode?: CommandSandboxMode
  image?: string
  readOnly?: boolean
  dockerContext?: string
  dockerHost?: string
  runner?: SandboxRunner
}

export const RunCommandInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(10_000),
})

export type RunCommandInput = z.infer<typeof RunCommandInputSchema>

export class RunCommandTool implements Tool<RunCommandInput> {
  readonly name = 'run_command'
  readonly description =
    'Run a process without a shell in the workspace root. In Docker mode, execution is isolated from the network.'
  readonly inputSchema = RunCommandInputSchema
  readonly sideEffect = 'process' as const

  private readonly sandboxRunner: SandboxRunner

  constructor(private readonly options: RunCommandOptions = {}) {
    this.sandboxRunner =
      options.runner ??
      (options.mode === 'docker' ? new DockerSandboxRunner(options) : new HostSandboxRunner())
  }

  async execute(input: RunCommandInput, context: ToolContext) {
    context.policy.assertCommandsAllowed()
    pathPolicyOf(context).assertCommand(input.command, input.args)
    return this.sandboxRunner.run(input, {
      workspaceRoot: context.workspaceRoot,
      abortSignal: context.abortSignal,
      redact: (value) => redactorOf(context).redact(value),
    })
  }
}
