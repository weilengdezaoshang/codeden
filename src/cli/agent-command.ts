import { NoopEventSink } from '../core/events/event-sink.js'
import { TemporaryWorkspaceAdapter } from '../eval/adapters/workspaces/temporary-workspace.adapter.js'
import { GitWorktreeSession } from '../runtime/workspace/git-worktree-session.js'
import { AgentRuntimeFactory } from '../runtime/agent/agent-runtime-factory.js'
import { SecureEventSink } from '../security/secure-event-sink.js'
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
import type { UiFileChange } from './terminal-ui.js'
import { ProjectInspector } from '../runtime/project/project-inspector.js'
import { buildInteractiveTaskSpec } from '../runtime/task/task-spec-builder.js'
import { captureBaseline } from '../runtime/verification/baseline-recorder.js'
import { DefaultCompletionVerifier } from '../runtime/verification/completion-verifier.js'
import type { AgentRunResult } from '../eval/ports/agent.port.js'
import {
  RevisionBoundCompletionVerifier,
  type VerifiedWorkspaceSnapshot,
} from '../runtime/attempts/verified-workspace-snapshot.js'

const execFileAsync = promisify(execFile)

export type PersonaCommand = { type: 'show' } | { type: 'clear' } | { type: 'set'; value: string }

export type ChangeCommand = 'diff' | 'apply' | 'discard'

export function allowsInteractiveWriteback(
  result: Pick<AgentRunResult, 'status' | 'verifiedSnapshot'>,
): boolean {
  return result.status === 'verified_complete' && result.verifiedSnapshot !== undefined
}

export function isSuccessfulAgentResult(status: AgentRunResult['status']): boolean {
  return status === 'submitted' || status === 'verified_complete'
}

export function parseChangeCommand(input: string): ChangeCommand | undefined {
  if (input === '/diff') {
    return 'diff'
  }
  if (input === '/apply') {
    return 'apply'
  }
  if (input === '/discard') {
    return 'discard'
  }
  return undefined
}

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
      `${USAGE}\nCommands: /help /status /history /cost /plan /persona <style> /memory /skills /skill <name> /compact /diff /apply /discard /clear /exit`,
    )
    return 0
  }
  if (!prompt && !interactive) {
    console.error(USAGE)
    return 1
  }

  let mcpManager: McpManager | undefined
  let interactiveWorkspaceSession: GitWorktreeSession | undefined
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

    interactiveWorkspaceSession = interactive
      ? await GitWorktreeSession.open(workspacePath, security, config.network.commands)
      : undefined
    const workspace =
      interactiveWorkspaceSession?.workspace ??
      (await TemporaryWorkspaceAdapter.fromExisting(workspacePath, {
        deleteOnDispose: false,
      }))
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
    let verifiedWorkspaceSnapshot: VerifiedWorkspaceSnapshot | undefined
    let finishInteractive: () => void = () => undefined
    const ui = interactive
      ? new TerminalUi({
          onSubmit: async (input) => {
            if (input === '/help') {
              ui?.addMessage({
                role: 'system',
                content:
                  '/help  /status  /history  /sessions  /cost  /plan  /persona <style>  /memory  /skills  /skill <name>  /compact  /diff  /apply  /discard  /clear  /exit\nUse /plan to toggle read-only planning mode.',
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
            const changeCommand = parseChangeCommand(input)
            if (changeCommand === 'diff') {
              try {
                const changedPaths = await refreshChanges()
                ui?.addMessage({
                  role: 'system',
                  content:
                    changedPaths.length === 0
                      ? 'No pending file changes.'
                      : `Pending changes: ${changedPaths.join(', ')}`,
                })
              } catch (error) {
                reportChangeCommandError(ui, error)
              }
              return
            }
            if (changeCommand === 'discard') {
              if (!interactiveWorkspaceSession?.isolated) {
                ui?.addMessage({
                  role: 'system',
                  content: '当前工作区未启用隔离，无法安全丢弃修改。',
                })
                return
              }
              try {
                await interactiveWorkspaceSession.discardChanges()
                verifiedWorkspaceSnapshot = undefined
                ui?.setFileChanges([])
                ui?.addMessage({ role: 'system', content: 'Pending changes discarded.' })
              } catch (error) {
                reportChangeCommandError(ui, error)
              }
              return
            }
            if (changeCommand === 'apply') {
              if (!interactiveWorkspaceSession?.isolated) {
                ui?.addMessage({ role: 'system', content: '当前工作区未启用隔离，无法写回修改。' })
                return
              }
              try {
                const changedPaths = await workspace.changedPaths()
                if (changedPaths.length === 0) {
                  ui?.addMessage({ role: 'system', content: 'No pending file changes.' })
                  return
                }
                if (!verifiedWorkspaceSnapshot) {
                  ui?.addMessage({
                    role: 'system',
                    content: '当前修改未通过完成验证，禁止写回原工作区。',
                  })
                  return
                }
                const applied =
                  await interactiveWorkspaceSession.applyVerifiedSnapshot(verifiedWorkspaceSnapshot)
                if (applied.conflicts.length === 0) {
                  await interactiveWorkspaceSession.refreshSnapshot()
                  verifiedWorkspaceSnapshot = undefined
                  ui?.setFileChanges([])
                }
                ui?.addMessage({ role: 'system', content: formatApplyResult(applied) })
              } catch (error) {
                reportChangeCommandError(ui, error)
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
              verifiedWorkspaceSnapshot = allowsInteractiveWriteback(turn.result)
                ? turn.result.verifiedSnapshot
                : undefined
              await refreshChanges()
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
    async function refreshChanges(): Promise<string[]> {
      const changedPaths = await workspace.changedPaths()
      ui?.setFileChanges(await collectFileChanges(workspace.root, changedPaths))
      return changedPaths
    }
    const eventSink = new SecureEventSink(
      ui ? new TerminalUiEventSink(ui) : new NoopEventSink(),
      security.redactor,
      security.guard,
    )
    session = new AgentSessionFactory().create({
      agent,
      context: async (_turnPrompt, turn, task) => {
        const baseline = await captureBaseline(task.taskSpec, workspace)
        return {
          runId: `cli-${turn}`,
          trialId: `cli-${turn}`,
          workspace,
          eventSink,
          limits: { maxTurns, maxToolCalls },
          submissionType: 'files',
          allowedPaths: task.taskSpec.allowedPaths,
          completionVerifier: new RevisionBoundCompletionVerifier(
            new DefaultCompletionVerifier(baseline),
            {
              attemptId: `cli-${turn}`,
              baseCommit: interactiveWorkspaceSession?.baseRevision,
            },
          ),
          memory: memoryEntries,
          skills,
          activeSkill: session.currentSkill,
          confirmTool: ui
            ? (toolName, arguments_, abortSignal) => ui.confirm(toolName, arguments_, abortSignal)
            : undefined,
        }
      },
      task: async (turnPrompt, turn) => {
        const [facts, pendingPaths] = await Promise.all([
          new ProjectInspector().inspect(workspace.root),
          workspace.changedPaths(),
        ])
        return {
          prompt: turnPrompt,
          taskSpec: buildInteractiveTaskSpec(turnPrompt, facts, pendingPaths, `cli-task-${turn}`),
        }
      },
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
      if (first) {
        verifiedWorkspaceSnapshot = allowsInteractiveWriteback(first.result)
          ? first.result.verifiedSnapshot
          : undefined
      }
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
      return isSuccessfulAgentResult(result.status) ? 0 : 1
    } finally {
      session.close()
      try {
        if (interactiveWorkspaceSession) {
          try {
            const changedPaths = await workspace.changedPaths()
            if (verifiedWorkspaceSnapshot && changedPaths.length > 0) {
              const applied =
                await interactiveWorkspaceSession.applyVerifiedSnapshot(verifiedWorkspaceSnapshot)
              if (applied.conflicts.length > 0) {
                console.error(`存在未写回的冲突文件：${applied.conflicts.join(', ')}`)
              }
            }
          } finally {
            await interactiveWorkspaceSession.dispose()
          }
        } else {
          await workspace.dispose()
        }
      } finally {
        await mcpManager.close()
      }
    }
  } catch (error) {
    await mcpManager?.close()
    await interactiveWorkspaceSession?.dispose()
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

async function collectFileChanges(
  workspaceRoot: string,
  changedPaths: string[],
): Promise<UiFileChange[]> {
  return Promise.all(
    changedPaths.map(async (filePath) => ({
      path: filePath,
      diff: await readGitDiff(workspaceRoot, filePath),
    })),
  )
}

function formatApplyResult(result: {
  applied: string[]
  unchanged: string[]
  conflicts: string[]
  patchPath?: string
}): string {
  const parts = [`Applied: ${result.applied.length}`, `unchanged: ${result.unchanged.length}`]
  if (result.conflicts.length > 0) {
    parts.push(`conflicts: ${result.conflicts.join(', ')}`)
  }
  if (result.patchPath) {
    parts.push(`patch: ${result.patchPath}`)
  }
  return parts.join('; ')
}

function reportChangeCommandError(
  ui: Pick<TerminalUi, 'addMessage'> | undefined,
  error: unknown,
): void {
  ui?.addMessage({
    role: 'system',
    content: `变更命令执行失败：${error instanceof Error ? error.message : String(error)}`,
  })
}

const entrypoint = process.argv[1] ? path.basename(process.argv[1]) : ''
const isDirect = entrypoint === 'agent-command.ts' || entrypoint === 'agent-command.js'
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
