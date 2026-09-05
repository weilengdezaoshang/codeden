import { z } from 'zod'
import { pathPolicyOf, redactorOf } from '../tool-security.js'
import type { SandboxRunner } from '../../sandbox/sandbox-runner.js'
import { createSandboxRunner } from '../../sandbox/sandbox-runner-factory.js'
import type { SandboxRunnerOptions } from '../../sandbox/sandbox-runner-factory.js'
import type { Tool, ToolContext } from '../tool.js'

const InputSchema = z.object({
  tool: z.enum(['tsc', 'eslint', 'pyright', 'cargo']).default('tsc'),
  path: z.string().trim().min(1).optional(),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(30_000),
})

export type GetDiagnosticsInput = z.infer<typeof InputSchema>

export class GetDiagnosticsTool implements Tool<GetDiagnosticsInput> {
  readonly name = 'get_diagnostics'
  readonly description =
    'Run a configured language or lint checker and return normalized diagnostics plus bounded raw output.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'process' as const
  readonly timeoutForInput = (input: GetDiagnosticsInput) =>
    Math.min(Math.max(input.timeoutMs + 5_000, 15_000), 600_000)
  private readonly sandboxRunner: SandboxRunner

  constructor(private readonly options: SandboxRunnerOptions = {}) {
    this.sandboxRunner = createSandboxRunner(options)!
  }

  async execute(input: GetDiagnosticsInput, context: ToolContext) {
    context.policy.assertCommandsAllowed()
    const path = input.path ?? '.'
    pathPolicyOf(context).assertReadable(path)
    const resolvedPath = await context.policy.resolveReadable(path)
    const command = commandFor(input.tool)
    const args = argsFor(input.tool, resolvedPath, input.args)
    pathPolicyOf(context).assertCommand(command, args)
    const result = await this.sandboxRunner.run(
      { command, args, timeoutMs: input.timeoutMs },
      {
        workspaceRoot: context.workspaceRoot,
        abortSignal: context.abortSignal,
        redact: (value) => redactorOf(context).redact(value),
      },
    )
    return {
      tool: input.tool,
      path: input.path,
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      diagnostics: parseDiagnostics(input.tool, result.stdout, result.stderr),
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    }
  }
}

function commandFor(tool: GetDiagnosticsInput['tool']): string {
  return tool === 'tsc' || tool === 'eslint' ? 'npx' : tool
}

function argsFor(tool: GetDiagnosticsInput['tool'], path: string, args: string[]): string[] {
  if (tool === 'tsc') {
    return [
      '--no-install',
      'tsc',
      '--noEmit',
      '--pretty',
      'false',
      ...(path === '.' ? [] : [path]),
      ...args,
    ]
  }
  if (tool === 'eslint') {
    return ['--no-install', 'eslint', path, '--format', 'json', ...args]
  }
  if (tool === 'pyright') {
    return [path, ...args]
  }
  return ['check', '--message-format=json', ...args]
}

function parseDiagnostics(tool: GetDiagnosticsInput['tool'], stdout: string, stderr: string) {
  if (tool === 'eslint') {
    try {
      const reports = JSON.parse(stdout) as Array<{
        filePath?: string
        messages?: Array<Record<string, unknown>>
      }>
      return reports.flatMap((report) =>
        (report.messages ?? []).map((message) => ({
          file: typeof report.filePath === 'string' ? report.filePath : undefined,
          line: numberOf(message.line),
          column: numberOf(message.column),
          severity: message.severity === 2 ? 'error' : 'warning',
          message: String(message.message ?? ''),
          code: typeof message.ruleId === 'string' ? message.ruleId : undefined,
        })),
      )
    } catch {
      return parseTextDiagnostics(stdout + '\n' + stderr)
    }
  }
  if (tool === 'cargo') {
    return stdout.split('\n').flatMap((line) => {
      try {
        const item = JSON.parse(line) as { reason?: string; message?: Record<string, unknown> }
        if (item.reason !== 'compiler-message' || !item.message) {
          return []
        }
        const message = item.message
        const spans = Array.isArray(message.spans) ? message.spans : []
        const primary = spans.find(
          (span) =>
            typeof span === 'object' && span !== null && 'is_primary' in span && span.is_primary,
        ) as Record<string, unknown> | undefined
        return [
          {
            file: typeof primary?.file_name === 'string' ? primary.file_name : undefined,
            line: numberOf(primary?.line_start),
            column: numberOf(primary?.column_start),
            severity: message.level === 'error' ? 'error' : 'warning',
            message: String(message.message ?? ''),
            code: undefined,
          },
        ]
      } catch {
        return []
      }
    })
  }
  return parseTextDiagnostics(stdout + '\n' + stderr)
}

function parseTextDiagnostics(text: string): Array<{
  file?: string
  line?: number
  column?: number
  severity: string
  message: string
  code?: string
}> {
  const result: Array<{
    file?: string
    line?: number
    column?: number
    severity: string
    message: string
    code?: string
  }> = []
  const pattern = /^(.*?):(\d+):(\d+):?\s*(error|warning)?\s*:??\s*(.*)$/iu
  for (const line of text.split('\n')) {
    const match = line.match(pattern)
    if (!match || !match[5]?.trim()) {
      continue
    }
    result.push({
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      severity: (match[4] ?? 'error').toLowerCase(),
      message: match[5].trim(),
    })
  }
  return result
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
