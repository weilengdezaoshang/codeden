import { z } from 'zod'
import { pathPolicyOf, redactorOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'
import type { SandboxRunner } from '../../sandbox/sandbox-runner.js'
import { createSandboxRunner } from '../../sandbox/sandbox-runner-factory.js'
import type { SandboxRunnerOptions } from '../../sandbox/sandbox-runner-factory.js'
import path from 'node:path'

export type CommandSandboxMode = 'host' | 'docker'

export interface RunCommandOptions extends SandboxRunnerOptions {
  mode?: CommandSandboxMode
}

export const RunCommandInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(10_000),
})

export type RunCommandInput = z.infer<typeof RunCommandInputSchema>

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'cut',
  'diff',
  'du',
  'file',
  'find',
  'grep',
  'head',
  'less',
  'ls',
  'more',
  'pwd',
  'rg',
  'ripgrep',
  'sed',
  'sort',
  'stat',
  'tail',
  'tree',
  'uniq',
  'wc',
])

const READ_ONLY_GIT_COMMANDS = new Set([
  'blame',
  'branch',
  'describe',
  'diff',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'show',
  'shortlog',
  'status',
])

const WRITE_LIKE_FLAGS = new Set([
  '--delete',
  '--exec',
  '--execdir',
  '--fprint',
  '--fprint0',
  '--fprintf',
  '--fls',
  '--in-place',
  '--ok',
  '--okdir',
  '-delete',
  '-exec',
  '-execdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
  '-ok',
  '-okdir',
  '-D',
  '-d',
  '-i',
])

export function isReadOnlyCommand(input: Pick<RunCommandInput, 'command' | 'args'>): boolean {
  const executable = path.basename(input.command)
  if (executable === 'git') {
    const subcommand = input.args.find((arg) => !arg.startsWith('-'))
    return (
      Boolean(subcommand && READ_ONLY_GIT_COMMANDS.has(subcommand)) && !hasWriteLikeFlag(input.args)
    )
  }
  if (!READ_ONLY_COMMANDS.has(executable)) {
    return false
  }
  return !hasWriteLikeFlag(input.args)
}

export class RunCommandTool implements Tool<RunCommandInput> {
  readonly name = 'run_command'
  readonly description =
    'Run a process without a shell in the workspace root. Read-only inspection commands such as cat, grep, and ls do not require permission. In Docker mode, execution is isolated from the network.'
  readonly inputSchema = RunCommandInputSchema
  readonly sideEffect = 'process' as const
  readonly sideEffectForInput = (input: RunCommandInput) =>
    isReadOnlyCommand(input) ? ('read' as const) : ('process' as const)
  // 执行器默认 15s 上限对构建、安装依赖这类长命令过短；按入参放宽并保留宽限余量。
  readonly timeoutForInput = (input: RunCommandInput) =>
    Math.min(Math.max(input.timeoutMs + 5_000, 15_000), 600_000)

  private readonly sandboxRunner: SandboxRunner

  constructor(private readonly options: RunCommandOptions = {}) {
    this.sandboxRunner = createSandboxRunner(options)!
  }

  async execute(input: RunCommandInput, context: ToolContext) {
    context.policy.assertCommandsAllowed({ readOnly: isReadOnlyCommand(input) })
    pathPolicyOf(context).assertCommand(input.command, input.args)
    return this.sandboxRunner.run(input, {
      workspaceRoot: context.workspaceRoot,
      abortSignal: context.abortSignal,
      redact: (value) => redactorOf(context).redact(value),
    })
  }
}

function hasWriteLikeFlag(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (WRITE_LIKE_FLAGS.has(arg)) {
      return true
    }
    return [...WRITE_LIKE_FLAGS].some((flag) => {
      if (arg.startsWith(`${flag}=`)) {
        return true
      }
      return flag.length === 2 && arg.startsWith(flag) && arg.length > flag.length
    })
  })
}
