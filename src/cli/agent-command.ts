import { NoopEventSink } from '../core/events/event-sink.js'
import { TemporaryWorkspaceAdapter } from '../eval/adapters/workspaces/temporary-workspace.adapter.js'
import { AgentRuntimeFactory } from '../runtime/agent/agent-runtime-factory.js'
import { SecureEventSink } from '../security/secure-event-sink.js'
import { parseTaskSpec } from '../core/task/task-spec.js'
import { readFlag, readNumberFlag } from './args.js'
import { AgentSession } from '../runtime/session/agent-session.js'
import type { SessionTurn } from '../runtime/session/agent-session.js'
import { AgentSessionFactory } from '../runtime/session/agent-session-factory.js'
import { DependencyContainer } from './dependency-container.js'
import { TerminalUi } from './terminal-ui.js'
import { TerminalUiEventSink } from './terminal-ui-event-sink.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MemoryStore } from '../runtime/memory/memory-store.js'
import { SkillLoader, type SkillDefinition } from '../runtime/skills/skill-loader.js'
import { McpManager } from '../runtime/mcp/mcp-manager.js'
import { SessionStore } from '../runtime/session/session-store.js'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export type PersonaCommand = { type: 'show' } | { type: 'clear' } | { type: 'set'; value: string }

export function parsePersonaCommand(input: string): PersonaCommand | undefined {
  if (input === '/persona') {
    return { type: 'show' }
  }
  if (input === '/persona clear') {
    return { type: 'clear' }
  }
  if (input.startsWith('/persona ')) {
    const value = input.slice('/persona '.length).trim()
    return value ? { type: 'set', value } : { type: 'show' }
  }
  return undefined
}

export const DEFAULT_SESSION_ID = 'default'

export function resolveSessionId(argv: string[], interactive: boolean): string | undefined {
  return (
    readFlag(argv, '--session') ??
    // 保留旧参数以兼容已有脚本；新用法应使用默认会话或 --session。
    readFlag(argv, '--resume') ??
    (interactive ? DEFAULT_SESSION_ID : undefined)
  )
}

const USAGE =
  'Usage: pnpm agent --prompt <text> [--interactive] [--session <id>] [--model mock|openai|anthropic|deepseek|grok] [--workspace <path>]'

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const prompt = readFlag(argv, '--prompt')
  const interactive = argv.includes('--interactive')
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      `${USAGE}\nCommands: /help /status /history /cost /plan /persona <style> /memory /skills /skill <name> /compact /clear /exit`,
    )
    return 0
  }
  if (!prompt && !interactive) {
    console.error(USAGE)
    return 1
  }

  let mcpManager: McpManager | undefined
  try {
    const workspacePath = readFlag(argv, '--workspace') ?? process.cwd()
    const modelName = readFlag(argv, '--model')
    const sessionId = resolveSessionId(argv, interactive)
    const container = new DependencyContainer()
    const security = container.security
    const config = await container.loadConfig(workspacePath, [process.cwd()])
    const model = container.createProvider(config, undefined, modelName)
    const memoryStore = new MemoryStore({ projectRoot: workspacePath })
    let memoryEntries = await memoryStore.list()
    const skills = await new SkillLoader({ projectRoot: workspacePath }).discover()
    mcpManager = new McpManager(config.mcp.servers, security.resolver)
    const mcpTools = Object.keys(config.mcp.servers).length > 0 ? await mcpManager.connectAll() : []
    const maxTurns = readNumberFlag(argv, '--max-turns', config.agent.maxTurns)
    const maxToolCalls = readNumberFlag(argv, '--max-tool-calls', config.agent.maxToolCalls)

    const workspace = await TemporaryWorkspaceAdapter.fromExisting(workspacePath, {
      deleteOnDispose: false,
    })
    const sessionStore = new SessionStore(workspacePath, security.redactor)
    const agent = new AgentRuntimeFactory().createFromConfig({
      config,
      provider: model,
      security,
      additionalTools: mcpTools,
    })
    // Session is assigned after the UI callback is created so both share the same instance.
    // eslint-disable-next-line prefer-const
    let session: AgentSession
    let lastResult: Awaited<ReturnType<AgentSession['submit']>>['result'] | undefined
    let finishInteractive: () => void = () => undefined
    const ui = interactive
      ? new TerminalUi({
          onSubmit: async (input) => {
            if (input === '/help') {
              ui?.addMessage({
                role: 'system',
                content:
                  '/help  /status  /history  /sessions  /cost  /plan  /persona <style>  /memory  /skills  /skill <name>  /compact  /clear  /exit\nUse /plan to toggle read-only planning mode.',
              })
              return
            }
            if (input === '/exit' || input === '/quit') {
              await ui?.stop()
              return
            }
            if (input === '/clear') {
              session.clearHistory()
              ui?.clearMessages()
              ui?.addMessage({ role: 'system', content: 'Conversation history cleared.' })
              return
            }
            if (input === '/history') {
              const count = session.history.length
              ui?.addMessage({ role: 'system', content: `Conversation turns: ${count}` })
              return
            }
            if (input === '/sessions') {
              const ids = await sessionStore.list()
              ui?.addMessage({
                role: 'system',
                content: ids.length === 0 ? 'No saved sessions.' : ids.join('\n'),
              })
              return
            }
            if (input === '/session clear') {
              if (sessionId) {
                session.reset()
                await sessionStore.clear(sessionId)
                ui?.addMessage({ role: 'system', content: `Session cleared: ${sessionId}` })
              }
              return
            }
            if (input === '/memory' || input === '/memory list') {
              const content =
                memoryEntries.length === 0
                  ? 'No persistent memories.'
                  : memoryEntries
                      .map((entry) => `[${entry.scope}/${entry.kind}] ${entry.content}`)
                      .join('\n')
              ui?.addMessage({ role: 'system', content })
              return
            }
            if (input === '/memory clear') {
              await memoryStore.clear('project')
              memoryEntries = await memoryStore.list()
              ui?.addMessage({ role: 'system', content: 'Project memory cleared.' })
              return
            }
            if (input.startsWith('/memory add ')) {
              try {
                await memoryStore.add(input.slice('/memory add '.length), { scope: 'project' })
                memoryEntries = await memoryStore.list()
                ui?.addMessage({ role: 'system', content: 'Memory saved.' })
              } catch (error) {
                ui?.addMessage({
                  role: 'system',
                  content: error instanceof Error ? error.message : String(error),
                })
              }
              return
            }
            if (input === '/skills') {
              ui?.addMessage({
                role: 'system',
                content:
                  skills.length === 0
                    ? 'No skills discovered.'
                    : skills.map(formatSkill).join('\n'),
              })
              return
            }
            if (input.startsWith('/skill ')) {
              const name = input.slice('/skill '.length).trim()
              if (!skills.some((skill) => skill.name === name)) {
                ui?.addMessage({ role: 'system', content: `Skill not found: ${name}` })
              } else {
                session.setActiveSkill(name)
                ui?.addMessage({ role: 'system', content: `Active skill: ${name}` })
              }
              return
            }
            if (input === '/status') {
              ui?.addMessage({
                role: 'system',
                content: `Turns: ${session.history.length}; mode: ${session.isPlanMode ? 'plan' : 'execute'}; persona: ${session.currentPersona || 'default'}`,
              })
              return
            }
            if (input === '/compact') {
              const removed = session.compactHistory()
              ui?.addMessage({
                role: 'system',
                content:
                  removed > 0 ? `Compacted ${removed} conversation turns.` : 'Nothing to compact.',
              })
              return
            }
            if (input === '/plan') {
              const enabled = session.togglePlanMode()
              ui?.addMessage({
                role: 'system',
                content: `Plan mode ${enabled ? 'enabled' : 'disabled'}.`,
              })
              return
            }
            const personaCommand = parsePersonaCommand(input)
            if (personaCommand?.type === 'show') {
              ui?.addMessage({
                role: 'system',
                content: `Current persona: ${session.currentPersona || 'default'}`,
              })
              return
            }
            if (personaCommand?.type === 'clear') {
              session.setPersona('')
              ui?.addMessage({ role: 'system', content: 'Session persona cleared.' })
              return
            }
            if (personaCommand?.type === 'set') {
              session.setPersona(personaCommand.value)
              ui?.addMessage({ role: 'system', content: 'Session persona updated.' })
              return
            }
            if (input === '/cost') {
              const metrics = session.history.reduce(
                (total, turn) => ({
                  inputTokens: total.inputTokens + turn.result.metrics.inputTokens,
                  outputTokens: total.outputTokens + turn.result.metrics.outputTokens,
                  toolCalls: total.toolCalls + turn.result.metrics.toolCalls,
                }),
                { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
              )
              ui?.addMessage({
                role: 'system',
                content: `Tokens in/out: ${metrics.inputTokens}/${metrics.outputTokens}; tool calls: ${metrics.toolCalls}`,
              })
              return
            }
            ui?.addMessage({ role: 'user', content: input })
            try {
              const turn = await session.submit(input)
              lastResult = turn.result
              const changedPaths = await workspace.changedPaths()
              const files = await Promise.all(
                changedPaths.map(async (path) => ({
                  path,
                  diff: await readGitDiff(workspacePath, path),
                })),
              )
              ui?.setFileChanges(files)
            } catch (error) {
              ui?.addMessage({
                role: 'system',
                content: `Agent execution failed: ${error instanceof Error ? error.message : String(error)}`,
              })
            }
          },
          onExit: () => {
            session.close()
            finishInteractive()
          },
          onCancel: () => {
            if (session.cancel()) {
              ui?.addMessage({ role: 'system', content: 'Agent run cancelled.' })
            }
          },
        })
      : undefined
    const eventSink = new SecureEventSink(
      ui ? new TerminalUiEventSink(ui) : new NoopEventSink(),
      security.redactor,
      security.guard,
    )
    session = new AgentSessionFactory().create({
      agent,
      context: (_turnPrompt, turn) => ({
        runId: `cli-${turn}`,
        trialId: `cli-${turn}`,
        workspace,
        eventSink,
        limits: { maxTurns, maxToolCalls },
        submissionType: 'files',
        allowedPaths: ['.'],
        memory: memoryEntries,
        skills,
        activeSkill: session.currentSkill,
        confirmTool: ui
          ? (toolName, arguments_, abortSignal) => ui.confirm(toolName, arguments_, abortSignal)
          : undefined,
      }),
      task: (turnPrompt, turn) => ({
        prompt: turnPrompt,
        taskSpec: parseTaskSpec({ id: `cli-task-${turn}`, goal: turnPrompt, allowedPaths: ['.'] }),
      }),
      persistence: sessionId ? { store: sessionStore, sessionId } : undefined,
    })
    if (sessionId && (await session.resume()) && ui) {
      restoreSessionHistory(ui, session.history, sessionId)
    }
    if (argv.includes('--plan')) {
      session.togglePlanMode()
    }
    let interactiveDone: Promise<void> | undefined
    if (ui) {
      interactiveDone = new Promise<void>((resolve) => {
        finishInteractive = resolve
      })
      ui.start()
    }
    try {
      if (prompt && ui) {
        ui.addMessage({ role: 'user', content: prompt })
      }
      const first = prompt ? await session.submit(prompt) : undefined
      lastResult = first?.result
      if (interactiveDone) {
        await interactiveDone
      }

      if (!first) {
        return 0
      }
      const result = lastResult ?? first.result

      console.log(`Status: ${result.status}`)
      if (result.finalResponse) {
        console.log(result.finalResponse)
      }
      if (result.submission) {
        console.log(`Submission: ${JSON.stringify(result.submission)}`)
      }
      return result.status === 'submitted' ? 0 : 1
    } finally {
      session.close()
      await mcpManager.close()
      await workspace.dispose()
    }
  } catch (error) {
    await mcpManager?.close()
    console.error(error instanceof Error ? error.message : error)
    console.error(USAGE)
    return 1
  }
}

function formatSkill(skill: SkillDefinition): string {
  return `${skill.name}: ${skill.description}${skill.whenToUse ? ` (${skill.whenToUse})` : ''}`
}

export function restoreSessionHistory(
  ui: Pick<TerminalUi, 'addMessage'>,
  history: readonly SessionTurn[],
  sessionId: string,
): void {
  for (const turn of history) {
    ui.addMessage({ role: 'user', content: turn.prompt })
    if (turn.result.finalResponse) {
      ui.addMessage({ role: 'assistant', content: turn.result.finalResponse })
    }
  }
  ui.addMessage({ role: 'system', content: `Conversation restored: ${sessionId}` })
}

async function readGitDiff(workspaceRoot: string, relativePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--', relativePath],
      { cwd: workspaceRoot, encoding: 'utf8' },
    )
    return stdout.trim() || '(no textual diff available)'
  } catch {
    return '(diff unavailable: workspace is not a Git repository)'
  }
}

const entrypoint = process.argv[1] ? path.basename(process.argv[1]) : ''
const isDirect = entrypoint === 'agent-command.ts' || entrypoint === 'agent-command.js'
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
