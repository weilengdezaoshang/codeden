import { stringify as stringifyYaml } from 'yaml'
import path from 'node:path'
import { main as agentMain } from './agent-command.js'
import { reportAgentResult } from './agent-result-reporter.js'
import { firstPositional, readFlag } from './args.js'
import { DependencyContainer } from './dependency-container.js'
import { main as evalMain } from './eval-command.js'
import { printError, printSafe } from './output.js'
import { chmod, mkdir, writeFile } from 'node:fs/promises'

const FORBIDDEN_FLAGS = ['--api-key', '--secret', '--authorization']
const USAGE = `Usage:
  codeden                         Start REPL and restore the last conversation
  codeden "<prompt>"              Run a one-shot task
  codeden --plan "<prompt>"       Run a read-only plan
  codeden --session <id>           Open another saved conversation
  codeden init [--force]           Create a starter project configuration
  codeden doctor                   Check configuration and Provider readiness
  codeden config validate          Validate configuration
  codeden config show              Show configuration
  codeden eval ...                 Run evaluations
`

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.some((arg) => FORBIDDEN_FLAGS.includes(arg))) {
    console.error('禁止通过 CLI 传递 API Key / secret / authorization')
    return 1
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
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
  if (command === 'init') {
    return initConfig(readFlag(argv, '--workspace') ?? process.cwd(), argv.includes('--force'))
  }
  if (command === 'doctor') {
    return doctor(readFlag(argv, '--workspace') ?? process.cwd())
  }

  const prompt = firstPositional(argv)
  if (shouldStartInteractive(argv)) {
    return agentMain(['--interactive', ...argv])
  }
  if (!prompt) {
    return agentMain(['--interactive', ...argv])
  }
  if (argv.includes('--plan')) {
    return agentMain(['--prompt', prompt, ...argv])
  }

  const container = new DependencyContainer()
  const redactor = container.security.redactor
  try {
    const workspaceRoot = readFlag(argv, '--workspace') ?? process.cwd()
    printSafe(`Workspace: ${workspaceRoot}`, redactor)
    printSafe('Running agent...', redactor)
    const { result, baseline, lastCheck, isolated, worktreeRoot, apply } = await container.runAgent(
      {
        workspaceRoot,
        prompt,
        providerName: readFlag(argv, '--provider'),
        modelName: readFlag(argv, '--model'),
      },
    )
    printSafe(
      isolated ? `Isolation: worktree ${worktreeRoot ?? ''}`.trim() : 'Isolation: inplace',
      redactor,
    )
    if (baseline) {
      printSafe(`Baseline: ${baseline.failing.length} failing`, redactor)
    }
    return reportAgentResult({ result, lastCheck, apply, redactor })
  } catch (error) {
    printError(error, redactor)
    return 1
  }
}

export function shouldStartInteractive(argv: string[]): boolean {
  const prompt = firstPositional(argv)
  return (
    !prompt ||
    hasFlag(argv, '--resume') ||
    hasFlag(argv, '--session') ||
    argv.includes('--interactive')
  )
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name) || readFlag(argv, name) !== undefined
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

export async function initConfig(workspaceRoot: string, force = false): Promise<number> {
  const configPath = path.join(path.resolve(workspaceRoot), '.codeden', 'config.yaml')
  try {
    await mkdir(path.dirname(configPath), { recursive: true })
    if (!force) {
      try {
        await writeFile(configPath, starterConfig(), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } catch (error) {
        if (isAlreadyExists(error)) {
          console.error(`配置已存在：${configPath}（如需覆盖请使用 --force）`)
          return 1
        }
        throw error
      }
    } else {
      await writeFile(configPath, starterConfig(), 'utf8')
      await chmod(configPath, 0o600)
    }
    console.log(`已创建配置：${configPath}`)
    console.log('下一步：设置 DEEPSEEK_API_KEY，或编辑配置选择其他 Provider。')
    return 0
  } catch (error) {
    printError(error)
    return 1
  }
}

export async function doctor(workspaceRoot: string): Promise<number> {
  try {
    const container = new DependencyContainer()
    const config = await container.loadConfig(workspaceRoot, [process.cwd()])
    const provider = config.providers[config.agent.defaultProvider]
    if (!provider) {
      throw new Error(`默认 Provider 不存在：${config.agent.defaultProvider}`)
    }
    container.createProvider(config)
    console.log(`✓ 配置有效：${config.agent.defaultProvider}`)
    console.log(`✓ 环境变量已配置：${provider.apiKey.name}`)
    console.log(`✓ 工作目录：${path.resolve(workspaceRoot)}`)
    return 0
  } catch (error) {
    printError(error)
    return 1
  }
}

function starterConfig(): string {
  return `schemaVersion: 1
agent:
  defaultProvider: deepseek
providers:
  deepseek:
    type: openai-compatible
    baseURL: https://api.deepseek.com
    apiKey:
      from: env
      name: DEEPSEEK_API_KEY
    defaultModel: deepseek-chat
    capabilities:
      tools: true
`
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

const entrypoint = process.argv[1] ? path.basename(process.argv[1]) : ''
const isDirect = entrypoint === 'codeden.ts' || entrypoint === 'codeden.js'
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
