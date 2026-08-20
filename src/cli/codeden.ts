import { stringify as stringifyYaml } from 'yaml'
import { CodeDenError } from '../core/errors/codeden-error.js'
import type { AgentSubmission } from '../eval/domain/agent-submission.js'
import type { SecretRedactor } from '../security/secret-redactor.js'
import { main as agentMain } from './agent-command.js'
import { firstPositional, readFlag } from './args.js'
import { DependencyContainer } from './dependency-container.js'
import { main as evalMain } from './eval-command.js'

const USAGE = `Usage:
  pnpm codeden "<prompt>"
  pnpm codeden config validate
  pnpm codeden config show
  pnpm codeden eval --case <path>
  pnpm codeden agent --prompt <text> [--model mock|openai|deepseek|grok]`

const FORBIDDEN_FLAGS = ['--api-key', '--secret', '--authorization']

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.some((arg) => FORBIDDEN_FLAGS.includes(arg))) {
    console.error('禁止通过 CLI 传递 API Key / secret / authorization')
    return 1
  }

  const command = argv[0]
  if (command === 'eval') {
    return evalMain(argv.slice(1))
  }
  if (command === 'agent') {
    return agentMain(argv.slice(1))
  }
  if (command === 'config' && argv[1] === 'validate') {
    return validateConfig(readFlag(argv, '--workspace') ?? process.cwd())
  }
  if (command === 'config' && argv[1] === 'show') {
    return showConfig(readFlag(argv, '--workspace') ?? process.cwd())
  }

  const prompt = firstPositional(argv)
  if (!prompt) {
    console.error(USAGE)
    return 1
  }

  const container = new DependencyContainer()
  const redactor = container.security.redactor
  try {
    const workspaceRoot = readFlag(argv, '--workspace') ?? process.cwd()
    printSafe(`Workspace: ${workspaceRoot}`, redactor)
    printSafe('Running agent...', redactor)
    const result = await container.runAgent({
      workspaceRoot,
      prompt,
      providerName: readFlag(argv, '--provider'),
      modelName: readFlag(argv, '--model'),
    })
    if (result.status === 'verified_complete') {
      printSafe('VERIFIED_COMPLETE', redactor)
      printSubmission(result.submission, redactor)
      if (result.finalResponse) {
        printSafe(result.finalResponse, redactor)
      }
      return 0
    }
    printSafe(`Status: ${result.status}`, redactor)
    printSubmission(result.submission, redactor)
    if (result.finalResponse) {
      printSafe(result.finalResponse, redactor)
    }
    return 1
  } catch (error) {
    printError(error, redactor)
    return 1
  }
}

async function validateConfig(workspaceRoot: string): Promise<number> {
  try {
    const container = new DependencyContainer()
    const configPath = await container.resolveConfigPath(workspaceRoot, [process.cwd()])
    const config = await container.loadConfig(workspaceRoot, [process.cwd()])
    container.createProvider(config)
    const redactor = container.security.redactor
    printSafe(`✓ ${configPath} 已加载`, redactor)
    printSafe(`✓ Provider ${config.agent.defaultProvider} 已配置`, redactor)
    printSafe(`✓ ${config.providers[config.agent.defaultProvider]?.apiKey.name} 可用`, redactor)
    printSafe('✓ Secret 未进入可打印配置', redactor)
    return 0
  } catch (error) {
    printError(error)
    return 1
  }
}

async function showConfig(workspaceRoot: string): Promise<number> {
  try {
    const container = new DependencyContainer()
    const config = await container.loadConfig(workspaceRoot, [process.cwd()])
    printSafe(stringifyYaml(config), container.security.redactor)
    return 0
  } catch (error) {
    printError(error)
    return 1
  }
}

function printSubmission(submission: AgentSubmission | undefined, redactor: SecretRedactor): void {
  if (submission?.type === 'files') {
    printSafe(`Changed paths: ${submission.changedPaths.join(', ') || '(none)'}`, redactor)
  }
}

function printSafe(line: string, redactor?: SecretRedactor): void {
  console.log(redactor ? redactor.redact(line) : line)
}

function printError(error: unknown, redactor?: SecretRedactor): void {
  const message = CodeDenError.isCodeDenError(error)
    ? error.message
    : error instanceof Error
      ? error.message
      : 'Command failed'
  console.error(redactor ? redactor.redact(message) : message)
}

const isDirect = process.argv[1]?.includes('codeden')
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
