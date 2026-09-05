import {
  BestEffortEventSink,
  CompositeEventSink,
  NoopEventSink,
} from '@codeden/core/events/event-sink.js'
import { TemporaryWorkspaceAdapter } from '@codeden/agent-runtime/workspace/temporary-workspace.js'
import { GitWorktreeSession } from '@codeden/agent-runtime/workspace/git-worktree-session.js'
import { AgentRuntimeFactory } from '@codeden/agent-runtime/agent/agent-runtime-factory.js'
import { SecureEventSink } from '@codeden/core/security/secure-event-sink.js'
import { readFlag, readNumberFlag } from '@codeden/core/cli/args.js'
import { AgentSession } from '@codeden/agent-runtime/session/agent-session.js'
import type { SessionActivity, SessionTurn } from '@codeden/agent-runtime/session/agent-session.js'
import { AgentSessionFactory } from '@codeden/agent-runtime/session/agent-session-factory.js'
import { DependencyContainer } from './dependency-container.js'
import { TerminalUi } from './terminal-ui.js'
import { TerminalUiEventSink } from './terminal-ui-event-sink.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MemoryStore } from '@codeden/agent-runtime/memory/memory-store.js'
import { SkillLoader, type SkillDefinition } from '@codeden/agent-runtime/skills/skill-loader.js'
import { McpManager } from '@codeden/agent-runtime/mcp/mcp-manager.js'
import {
  SessionStore,
  type SessionSnapshot,
  type SessionSummary,
} from '@codeden/agent-runtime/session/session-store.js'
import type { UiFileChange } from './terminal-ui.js'
import { ProjectInspector } from '@codeden/agent-runtime/project/project-inspector.js'
import { buildInteractiveTaskSpec } from '@codeden/agent-runtime/task/task-spec-builder.js'
import { captureBaseline } from '@codeden/agent-runtime/verification/baseline-recorder.js'
import { DefaultCompletionVerifier } from '@codeden/agent-runtime/verification/completion-verifier.js'
import type { AgentRunResult } from '@codeden/agent-runtime/agent/agent-contracts.js'
import {
  RevisionBoundCompletionVerifier,
  type VerifiedWorkspaceSnapshot,
} from '@codeden/agent-runtime/attempts/verified-workspace-snapshot.js'
import { createTraceCaptureSink } from '@codeden/telemetry/trace-capture-factory.js'
import { createId } from '@codeden/core/ids.js'
import { BackgroundTaskManager } from '@codeden/agent-runtime/tools/background-task-manager.js'
import {
  BUILTIN_PROVIDER_CONFIGS,
  builtinModelProfile,
} from '@codeden/agent-runtime/models/builtin-providers.js'
import type { ModelMessage } from '@codeden/agent-runtime/models/model-types.js'
import {
  computeUtilization,
  resolveModelProfile,
} from '@codeden/agent-runtime/context/context-budget.js'
import { FoldProjectionStore } from '@codeden/agent-runtime/context/folding/fold-projection-store.js'
import type { FoldSummaryDraft } from '@codeden/agent-runtime/context/folding/folded-memory.js'

const execFileAsync = promisify(execFile)

export type PersonaCommand = { type: 'show' } | { type: 'clear' } | { type: 'set'; value: string }

export type ChangeCommand = 'diff' | 'apply' | 'discard'

export type SessionCommand =
  | { type: 'new' }
  | { type: 'clear' }
  | { type: 'delete' }
  | { type: 'list' }
  | { type: 'resume'; sessionId: string }

export function parseSessionCommand(input: string): SessionCommand | undefined {
  if (input === '/new') {
    return { type: 'new' }
  }
  if (input === '/clear') {
    return { type: 'clear' }
  }
  if (input === '/delete' || input === '/session clear') {
    return { type: 'delete' }
  }
  if (input === '/sessions' || input === '/resume') {
    return { type: 'list' }
  }
  if (input.startsWith('/resume ')) {
    const sessionId = input.slice('/resume '.length).trim()
    return sessionId ? { type: 'resume', sessionId } : { type: 'list' }
  }
  return undefined
}

export type PermissionCommand = { type: 'show' } | { type: 'set'; value: 'ask' | 'auto' }

export function parsePermissionCommand(input: string): PermissionCommand | undefined {
  if (input === '/permission') {
    return { type: 'show' }
  }
  if (input === '/permission ask' || input === '/permission auto') {
    return { type: 'set', value: input.endsWith('auto') ? 'auto' : 'ask' }
  }
  return undefined
}

function parseReasoningEffort(value: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  throw new Error('--reasoning-effort must be low, medium, or high')
}

export function allowsInteractiveWriteback(
  result: Pick<AgentRunResult, 'status' | 'verifiedSnapshot'>,
): boolean {
  return result.status === 'verified_complete' && result.verifiedSnapshot !== undefined
}

export interface InteractiveSessionRunState {
  lastResult?: AgentRunResult
  verifiedWorkspaceSnapshot?: VerifiedWorkspaceSnapshot
}

export function clearInteractiveSessionRunState(state: InteractiveSessionRunState): void {
  state.lastResult = undefined
  state.verifiedWorkspaceSnapshot = undefined
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

export function resolveSessionId(argv: string[], _interactive: boolean): string | undefined {
  return (
    readFlag(argv, '--session') ??
    // 保留旧参数以兼容已有脚本；新用法应使用 --session 或 /resume。
    readFlag(argv, '--resume')
  )
}

const USAGE =
  'Usage: pnpm agent --prompt <text> [--interactive] [--session <id>] [--model mock|openai|anthropic|deepseek|grok] [--model-id <api-model>] [--workspace <path>]'

const COMPACTION_SUMMARY_PROMPT = [
  'Summarize the conversation so far so work can continue seamlessly.',
  'Keep: the user goal, decisions made, files and paths touched, pending steps, and unresolved questions.',
  'Drop: raw tool output and irrelevant detours. Reply with the summary text only.',
].join('\n')

const FOLD_SUMMARY_PROMPT = [
  '你是会话折叠助手。基于给定的确定性折叠记忆（JSON），输出更连贯的中文总结。',
  '只输出一个 JSON 对象：{"currentProgress": string, "currentChallenges": string[], "nextActions": string[], "derivedRules": string[]}。',
  '不得虚构未发生的事实；必须保留全部失败与未完成事项；不要输出 Markdown 代码块。',
].join('\n')

/** 从模型回复中提取折叠摘要草稿；非 JSON 输出返回 undefined，走确定性回退。 */
function parseFoldDraft(text: string): FoldSummaryDraft | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return undefined
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as FoldSummaryDraft
  } catch {
    return undefined
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const prompt = readFlag(argv, '--prompt')
  const interactive = argv.includes('--interactive')
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      `${USAGE}\nCommands: /help /status /context /history /sessions /resume <id> /new /delete /cost /plan /permission ask|auto /persona <style> /memory /skills /skill <name> /fold /compact /diff /apply /discard /clear /exit`,
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
    const requestedProviderName = readFlag(argv, '--provider')
    const modelName = readFlag(argv, '--model')
    const modelId = readFlag(argv, '--model-id')
    const requestedReasoningEffort = parseReasoningEffort(readFlag(argv, '--reasoning-effort'))
    const requestedSessionId = resolveSessionId(argv, interactive)
    const container = new DependencyContainer()
    const security = container.security
    const config = await container.loadConfig(workspacePath, [process.cwd()])
    const memoryStore = new MemoryStore({ projectRoot: workspacePath })
    let memoryEntries = await memoryStore.list()
    const skills = await new SkillLoader({ projectRoot: workspacePath }).discover()
    mcpManager = new McpManager(config.mcp.servers, security.resolver)
    const mcpTools = Object.keys(config.mcp.servers).length > 0 ? await mcpManager.connectAll() : []
    const maxTurns = readNumberFlag(argv, '--max-turns', config.agent.maxTurns)
    const maxToolCalls = readNumberFlag(argv, '--max-tool-calls', config.agent.maxToolCalls)
    const invocationId = createId()

    interactiveWorkspaceSession = interactive
      ? await GitWorktreeSession.open(workspacePath, security, config.network.commands)
      : undefined
    const workspace =
      interactiveWorkspaceSession?.workspace ??
      (await TemporaryWorkspaceAdapter.fromExisting(workspacePath, {
        deleteOnDispose: false,
      }))
    const sessionStore = new SessionStore(workspacePath, security.redactor)
    let activeSessionId: string | undefined = requestedSessionId
    if (interactive && !activeSessionId) {
      activeSessionId = (await sessionStore.latestSessionId()) ?? DEFAULT_SESSION_ID
    }
    // Session is assigned after the UI callback is created so both share the same instance.
    let session: AgentSession
    const runState: InteractiveSessionRunState = {}
    let finishInteractive: () => void = () => undefined
    const ui = interactive
      ? new TerminalUi({
          onSubmit: async (input) => {
            if (input === '/help') {
              ui?.addMessage({
                role: 'system',
                content:
                  '/help  /status  /context  /history  /sessions  /resume [id]  /new  /delete  /cost  /plan  /permission ask|auto  /persona <style>  /memory  /skills  /skill <name>  /fold  /compact  /diff  /apply  /discard  /clear  /exit\nUse /new to create a session, /resume to restore one, and /delete to remove the current session without changing workspace files.',
              })
              return
            }
            if (input === '/exit' || input === '/quit') {
              await ui?.stop()
              return
            }
            const sessionCommand = parseSessionCommand(input)
            if (sessionCommand?.type === 'new') {
              if (session.isRunning) {
                ui?.addMessage({
                  role: 'system',
                  content: '当前任务仍在运行，请等待完成或先取消。',
                })
                return
              }
              await reportSessionPersistence()
              if (session.persistErrorMessage) {
                return
              }
              const nextSessionId = createId()
              const previousTasks = activeBackgroundTasks
              const nextSession = createSession(nextSessionId)
              session.close()
              await killBackgroundTasks(previousTasks)
              clearInteractiveSessionRunState(runState)
              persistenceWarningActive = false
              activeSessionId = nextSessionId
              session = nextSession
              await session.clearHistory()
              ui?.clearMessages()
              ui?.addMessage({ role: 'system', content: `新会话已创建：${activeSessionId}` })
              await reportSessionPersistence()
              return
            }
            if (sessionCommand?.type === 'clear') {
              await session.clearHistory()
              clearInteractiveSessionRunState(runState)
              ui?.clearMessages()
              ui?.addMessage({ role: 'system', content: '当前会话历史已清空。' })
              await reportSessionPersistence()
              return
            }
            if (input === '/history') {
              const count = session.sessionTurnCount
              ui?.addMessage({ role: 'system', content: `Conversation turns: ${count}` })
              return
            }
            if (sessionCommand?.type === 'list') {
              const summaries = await sessionStore.listSummaries()
              ui?.addMessage({
                role: 'system',
                content: formatSessionSummaries(summaries),
              })
              return
            }
            if (sessionCommand?.type === 'resume') {
              if (session.isRunning) {
                ui?.addMessage({
                  role: 'system',
                  content: '当前任务仍在运行，请等待完成或先取消。',
                })
                return
              }
              await reportSessionPersistence()
              if (session.persistErrorMessage) {
                return
              }
              let snapshot: SessionSnapshot | undefined
              try {
                snapshot = await sessionStore.load(sessionCommand.sessionId)
              } catch (error) {
                const reason = (error instanceof Error ? error.message : String(error)).replaceAll(
                  workspacePath,
                  '<workspace>',
                )
                ui?.addMessage({
                  role: 'system',
                  content: `会话恢复失败：${security.redactor.redact(reason).slice(0, 240)}`,
                })
                return
              }
              if (!snapshot) {
                ui?.addMessage({
                  role: 'system',
                  content: `找不到会话：${sessionCommand.sessionId}`,
                })
                return
              }
              const settings = resolveSessionSettings(snapshot)
              const previousTasks = activeBackgroundTasks
              let nextSession: AgentSession
              try {
                nextSession = createSession(sessionCommand.sessionId, snapshot)
                await nextSession.resume({ ...snapshot, ...settings })
              } catch (error) {
                const reason = security.redactor
                  .redact(error instanceof Error ? error.message : String(error))
                  .replaceAll(workspacePath, '<workspace>')
                  .slice(0, 240)
                ui?.addMessage({ role: 'system', content: `会话恢复失败：${reason}` })
                return
              }
              session.close()
              await killBackgroundTasks(previousTasks)
              clearInteractiveSessionRunState(runState)
              persistenceWarningActive = false
              activeSessionId = sessionCommand.sessionId
              session = nextSession
              ui?.clearMessages()
              restoreSessionHistory(ui!, session.history, activeSessionId)
              syncUsage()
              for (const warning of snapshot.recoveryWarnings ?? []) {
                ui?.addMessage({ role: 'system', content: `⚠ ${warning}` })
              }
              return
            }
            if (sessionCommand?.type === 'delete') {
              if (!activeSessionId) {
                ui?.addMessage({ role: 'system', content: '当前会话尚未持久化，无需删除。' })
                return
              }
              if (session.isRunning) {
                ui?.addMessage({
                  role: 'system',
                  content: '当前任务仍在运行，请等待完成或先取消。',
                })
                return
              }
              const confirmed = await ui!.confirmAction(
                `删除当前会话 ${activeSessionId}？项目文件和 Git Diff 不会被修改`,
              )
              if (!confirmed) {
                ui?.addMessage({ role: 'system', content: '已取消删除会话。' })
                return
              }
              const deletedSessionId = activeSessionId
              await session.flush()
              await sessionStore.clear(deletedSessionId)
              session.close()
              clearInteractiveSessionRunState(runState)
              persistenceWarningActive = false
              const previousTasks = activeBackgroundTasks
              activeSessionId = createId()
              session = createSession(activeSessionId)
              await killBackgroundTasks(previousTasks)
              await session.clearHistory()
              ui?.clearMessages()
              ui?.addMessage({
                role: 'system',
                content: `会话已删除：${deletedSessionId}；已创建新会话：${activeSessionId}`,
              })
              await reportSessionPersistence()
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
                runState.verifiedWorkspaceSnapshot = undefined
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
                if (!runState.verifiedWorkspaceSnapshot) {
                  ui?.addMessage({
                    role: 'system',
                    content: '当前修改未通过完成验证，禁止写回原工作区。',
                  })
                  return
                }
                const applied = await interactiveWorkspaceSession.applyVerifiedSnapshot(
                  runState.verifiedWorkspaceSnapshot,
                )
                if (applied.conflicts.length === 0) {
                  await interactiveWorkspaceSession.refreshSnapshot()
                  runState.verifiedWorkspaceSnapshot = undefined
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
                await reportSessionPersistence()
                ui?.addMessage({ role: 'system', content: `Active skill: ${name}` })
              }
              return
            }
            if (input === '/status') {
              ui?.addMessage({
                role: 'system',
                content: `Turns: ${session.history.length}; mode: ${session.isPlanMode ? 'plan' : 'execute'}; permission: ${session.currentPermissionMode}; model: ${session.currentModel ?? 'default'}; persona: ${session.currentPersona || 'default'}`,
              })
              return
            }
            if (input === '/context') {
              const modelId = session.currentModel
              const profile = resolveModelProfile(builtinModelProfile(modelId))
              const utilization = computeUtilization(session.conversationMessages, profile)
              const thresholdTokens = Math.max(
                0,
                Math.floor(profile.contextWindowTokens * utilization.threshold) -
                  utilization.reserveOutputTokens,
              )
              const headroom = Math.max(0, thresholdTokens - utilization.estimatedInputTokens)
              const windowLabel = profile.estimated
                ? `${formatTokens(profile.contextWindowTokens)} tokens（模型未登记窗口，按保守默认估算）`
                : `${formatTokens(profile.contextWindowTokens)} tokens`
              ui?.addMessage({
                role: 'system',
                content: [
                  `Model: ${modelId ?? 'default'}; window: ${windowLabel}`,
                  `Estimated input: ~${formatTokens(utilization.estimatedInputTokens)} tokens; output reserve: ${formatTokens(utilization.reserveOutputTokens)} tokens`,
                  `Utilization: ${(utilization.ratio * 100).toFixed(1)}%; threshold: ${(utilization.threshold * 100).toFixed(0)}%; headroom to threshold: ~${formatTokens(headroom)} tokens`,
                ].join('\n'),
              })
              return
            }
            if (input === '/fold' || input === '/compact') {
              ui?.setStatus('正在折叠会话')
              let removed: number
              try {
                removed = session.supportsFold
                  ? await session.fold('manual')
                  : await session.compactHistory()
                await reportSessionPersistence()
              } finally {
                ui?.setStatus('Idle')
              }
              ui?.addMessage({
                role: 'system',
                content: removed > 0 ? `Folded ${removed} conversation turns.` : 'Nothing to fold.',
              })
              return
            }
            if (input === '/plan') {
              const enabled = session.togglePlanMode()
              await reportSessionPersistence()
              ui?.addMessage({
                role: 'system',
                content: `Plan mode ${enabled ? 'enabled' : 'disabled'}.`,
              })
              return
            }
            const permissionCommand = parsePermissionCommand(input)
            if (permissionCommand?.type === 'show') {
              ui?.addMessage({
                role: 'system',
                content: `Permission mode: ${session.currentPermissionMode}`,
              })
              return
            }
            if (permissionCommand?.type === 'set') {
              session.setPermissionMode(permissionCommand.value)
              await reportSessionPersistence()
              ui?.addMessage({
                role: 'system',
                content: `Permission mode: ${permissionCommand.value}`,
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
              await reportSessionPersistence()
              ui?.addMessage({ role: 'system', content: 'Session persona cleared.' })
              return
            }
            if (personaCommand?.type === 'set') {
              session.setPersona(personaCommand.value)
              await reportSessionPersistence()
              ui?.addMessage({ role: 'system', content: 'Session persona updated.' })
              return
            }
            if (input === '/cost') {
              const metrics = session.sessionMetrics
              ui?.addMessage({
                role: 'system',
                content: `Tokens in/out: ${metrics.inputTokens}/${metrics.outputTokens}; tool calls: ${metrics.toolCalls}`,
              })
              return
            }
            ui?.addMessage({ role: 'user', content: input })
            try {
              const turn = await session.submit(input)
              runState.lastResult = turn.result
              runState.verifiedWorkspaceSnapshot = allowsInteractiveWriteback(turn.result)
                ? turn.result.verifiedSnapshot
                : undefined
              await refreshChanges()
              await reportSessionPersistence()
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
    let persistenceWarningActive = false
    function syncUsage(): void {
      ui?.setUsage({
        inputTokens: session.sessionMetrics.inputTokens,
        outputTokens: session.sessionMetrics.outputTokens,
        turnCount: session.sessionTurnCount,
      })
    }
    async function reportSessionPersistence(): Promise<void> {
      await session.flush()
      syncUsage()
      const error = session.persistErrorMessage
      if (error) {
        persistenceWarningActive = true
        const safeReason = security.redactor
          .redact(error)
          .replaceAll(workspacePath, '<workspace>')
          .slice(0, 240)
        ui?.addMessage({
          role: 'system',
          content: `⚠ 会话保存失败。本轮内容仍在内存中，退出后可能丢失。原因：${safeReason}`,
        })
      } else if (persistenceWarningActive) {
        persistenceWarningActive = false
        ui?.addMessage({ role: 'system', content: '✓ 会话已重新保存。' })
      }
    }
    function resolveSessionSettings(snapshot?: SessionSnapshot) {
      const storedProvider = snapshot?.provider
      // --model 为内置 provider 别名时选择 Provider，wire model 交给该 Provider 的 defaultModel；
      // 其他取值视为显式 API 模型名（--model-id 与其等价，优先级更高）。
      const aliasProvider =
        modelName && modelName !== 'mock' && modelName in BUILTIN_PROVIDER_CONFIGS
          ? modelName
          : undefined
      const provider =
        requestedProviderName ??
        (modelName === 'mock'
          ? 'mock'
          : (aliasProvider ??
            (storedProvider === 'mock' || (storedProvider && storedProvider in config.providers)
              ? storedProvider
              : config.agent.defaultProvider)))
      const explicitModelId = modelId ?? (aliasProvider ? undefined : modelName)
      const storedModel = provider === storedProvider ? snapshot?.model : undefined
      const configuredModel =
        provider === 'mock' ? 'mock' : config.providers[provider]?.defaultModel
      const model = explicitModelId ?? storedModel ?? config.agent.defaultModel ?? configuredModel
      return {
        permissionMode: snapshot?.permissionMode ?? ('ask' as const),
        provider,
        model: provider === 'mock' ? 'mock' : model,
        reasoningEffort: requestedReasoningEffort ?? snapshot?.reasoningEffort,
      }
    }
    const terminalEventSink = ui ? new TerminalUiEventSink(ui) : new NoopEventSink()
    let activeBackgroundTasks: BackgroundTaskManager | undefined
    const killBackgroundTasks = async (
      manager: BackgroundTaskManager | undefined,
    ): Promise<void> => {
      if (manager) {
        await manager.killAll('session-switch')
      }
    }
    const createSession = (
      sessionId: string | undefined,
      snapshot?: SessionSnapshot,
    ): AgentSession => {
      const settings = resolveSessionSettings(snapshot)
      const model = container.createProvider(config, settings.provider, settings.model)
      const backgroundTasks = new BackgroundTaskManager()
      activeBackgroundTasks = backgroundTasks
      const agent = new AgentRuntimeFactory().createFromConfig({
        config,
        provider: model,
        providerName: settings.provider,
        security,
        additionalTools: mcpTools,
        backgroundTasks,
      })
      return new AgentSessionFactory().create({
        agent,
        context: async (_turnPrompt, turn, task) => {
          const baseline = await captureBaseline(task.taskSpec, workspace)
          const runId = `${invocationId}-${turn}`
          const traceCapture = await createTraceCaptureSink({
            projectRoot: workspacePath,
            runId,
            trialId: runId,
            security,
            telemetry: config.telemetry,
          })
          const eventSink = new SecureEventSink(
            new CompositeEventSink([terminalEventSink, new BestEffortEventSink(traceCapture)]),
            security.redactor,
            security.guard,
          )
          return {
            runId,
            trialId: runId,
            workspace,
            eventSink,
            limits: { maxTurns, maxToolCalls, runTimeoutMs: config.agent.turnTimeoutMs },
            submissionType: 'files',
            allowedPaths: task.taskSpec.allowedPaths,
            approvalMode: session.currentPermissionMode,
            reasoningEffort: session.currentReasoningEffort,
            completionVerifier: new RevisionBoundCompletionVerifier(
              new DefaultCompletionVerifier(baseline),
              {
                attemptId: runId,
                baseCommit: interactiveWorkspaceSession?.baseRevision,
              },
            ),
            memory: memoryEntries,
            skills,
            activeSkill: session.currentSkill,
            confirmTool: ui
              ? (toolName, arguments_, abortSignal) => ui.confirm(toolName, arguments_, abortSignal)
              : undefined,
            askUser: ui
              ? (question, options, abortSignal) => ui.ask(question, options, abortSignal)
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
        sessionOptions: {
          settings,
          // 结构化折叠开关：缺省关闭走旧压缩路径；开启后按窗口占用/熔断信号触发折叠。
          fold: config.agent.folding.enabled
            ? {
                store: new FoldProjectionStore(workspacePath),
                redactor: security.redactor,
                eventSink: terminalEventSink,
                profile: builtinModelProfile(settings.model),
                summarize: async ({ memory }) => {
                  try {
                    const response = await model.complete({
                      messages: [
                        { role: 'system', content: FOLD_SUMMARY_PROMPT },
                        {
                          role: 'user',
                          content: JSON.stringify({
                            task: memory.episodeMemory.taskDescription,
                            progress: memory.episodeMemory.currentProgress,
                            goal: memory.workingMemory.immediateGoal,
                            challenges: memory.workingMemory.currentChallenges,
                            nextActions: memory.workingMemory.nextActions,
                            tools: memory.toolMemory.toolsUsed,
                          }),
                        },
                      ],
                      tools: [],
                    })
                    const draft = parseFoldDraft(response.text ?? '')
                    return draft
                  } catch {
                    // 摘要失败走确定性回退（degraded=true），不阻塞折叠。
                    return undefined
                  }
                },
              }
            : undefined,
          summarize: async (messages: readonly ModelMessage[]): Promise<string> => {
            try {
              const clipped = messages.slice(-40).map((message) => ({
                ...message,
                content: message.content.slice(0, 2_000),
              }))
              const response = await model.complete({
                messages: [{ role: 'system', content: COMPACTION_SUMMARY_PROMPT }, ...clipped],
                tools: [],
              })
              return response.text ?? ''
            } catch {
              // 摘要失败时回退为 AgentSession 内置的截断说明，不阻塞压缩。
              return ''
            }
          },
        },
      })
    }
    let initialSnapshot: SessionSnapshot | undefined
    if (activeSessionId) {
      try {
        initialSnapshot = await sessionStore.load(activeSessionId)
      } catch (error) {
        const reason = security.redactor
          .redact(error instanceof Error ? error.message : String(error))
          .replaceAll(workspacePath, '<workspace>')
          .slice(0, 240)
        ui?.addMessage({ role: 'system', content: `会话恢复失败，将启动空会话：${reason}` })
        activeSessionId = createId()
      }
    }
    const initialSettings = resolveSessionSettings(initialSnapshot)
    session = createSession(activeSessionId, initialSnapshot)
    if (
      activeSessionId &&
      (await session.resume(
        initialSnapshot ? { ...initialSnapshot, ...initialSettings } : undefined,
      )) &&
      ui
    ) {
      restoreSessionHistory(ui, session.history, activeSessionId)
      syncUsage()
      for (const warning of initialSnapshot?.recoveryWarnings ?? []) {
        ui.addMessage({ role: 'system', content: `⚠ ${warning}` })
      }
    }
    if (argv.includes('--plan')) {
      session.togglePlanMode()
      await reportSessionPersistence()
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
      runState.lastResult = first?.result
      if (first) {
        runState.verifiedWorkspaceSnapshot = allowsInteractiveWriteback(first.result)
          ? first.result.verifiedSnapshot
          : undefined
      }
      if (interactiveDone) {
        await interactiveDone
      }

      if (!first) {
        return 0
      }
      const result = runState.lastResult ?? first.result

      console.log(`Status: ${result.status}`)
      if (result.finalResponse) {
        console.log(result.finalResponse)
      }
      if (result.submission) {
        console.log(`Submission: ${JSON.stringify(result.submission)}`)
      }
      return isSuccessfulAgentResult(result.status) ? 0 : 1
    } finally {
      await session.flush()
      session.close()
      try {
        if (interactiveWorkspaceSession) {
          try {
            const changedPaths = await workspace.changedPaths()
            if (runState.verifiedWorkspaceSnapshot && changedPaths.length > 0) {
              const applied = await interactiveWorkspaceSession.applyVerifiedSnapshot(
                runState.verifiedWorkspaceSnapshot,
              )
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

function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}

export function formatSessionSummaries(summaries: readonly SessionSummary[]): string {
  if (summaries.length === 0) {
    return '暂无已保存会话。输入 /new 开始新的会话。'
  }
  return [
    '历史会话（输入 /resume <id> 恢复）：',
    ...summaries.map(
      (summary) =>
        `• ${sessionLabel(summary.title)}  [${summary.sessionId}] · ${summary.turnCount} 轮 · ${sessionLabel(summary.preview)}`,
    ),
  ].join('\n')
}

function sessionLabel(value: string, maxLength = 64): string {
  const normalized = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

export function restoreSessionHistory(
  ui: Pick<TerminalUi, 'addMessage'>,
  history: readonly SessionTurn[],
  sessionId: string,
): void {
  for (const [turnIndex, turn] of history.entries()) {
    ui.addMessage({ role: 'user', content: turn.prompt })
    for (const activity of turn.activities ?? []) {
      ui.addMessage({
        role: activity.kind === 'tool' ? 'tool' : 'system',
        content: formatRestoredActivity(activity),
        activity: true,
        collapsed: true,
        activityKey: `history:${turnIndex}:${activity.id}`,
      })
    }
    if (turn.result.finalResponse) {
      ui.addMessage({ role: 'assistant', content: turn.result.finalResponse })
    }
  }
  ui.addMessage({ role: 'system', content: `会话已恢复：${sessionId}` })
}

function formatRestoredActivity(activity: SessionActivity): string {
  const icon = activity.status === 'failed' ? '✗' : activity.status === 'completed' ? '✓' : '◌'
  const duration =
    activity.durationMs === undefined ? '' : `（${Math.round(activity.durationMs)}ms）`
  const labels: Record<string, string> = {
    Thinking: '思考中',
    Verification: '验证',
    read_file: '读取文件',
    list_files: '浏览工作区',
    search_docs: '搜索文档',
    fetch_url: '读取网页',
    run_command: '运行命令',
    run_python: '运行 Python 脚本',
    edit_file: '修改文件',
    write_file: '写入文件',
    subagent: '委派子 Agent',
    apply_patch: '应用补丁',
    start_command: '启动后台命令',
    get_command_output: '查询后台命令',
    kill_command: '终止后台命令',
    get_diagnostics: '收集诊断',
    git_status: '查看 Git 状态',
    git_diff: '查看 Git diff',
    web_search: '搜索网页',
    web_fetch: '抓取网页',
    todo_write: '更新任务计划',
    ask_user: '询问用户',
    delete_file: '删除文件',
    move_file: '移动文件',
    repo_map: '生成仓库地图',
    find_symbol: '查找符号',
    find_references: '查找引用',
    read_many_files: '批量读取文件',
    search_files: '搜索文件',
  }
  return `${icon} ${labels[activity.label] ?? activity.label}${duration}`
}

async function readGitDiff(workspaceRoot: string, relativePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--', relativePath],
      { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
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

if (isEntrypoint(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
import { isEntrypoint } from '@codeden/core/cli/entrypoint.js'
