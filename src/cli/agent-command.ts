import { NoopEventSink } from '../core/events/event-sink.js'
import { TemporaryWorkspaceAdapter } from '../eval/adapters/workspaces/temporary-workspace.adapter.js'
import { AgentRuntimeFactory } from '../runtime/agent/agent-runtime-factory.js'
import { createModelProvider } from '../runtime/models/create-model-provider.js'
import { SecureEventSink } from '../security/secure-event-sink.js'
import { createSecurityServices } from '../security/security-services.js'
import { parseTaskSpec } from '../core/task/task-spec.js'
import { readFlag, readNumberFlag } from './args.js'
import { AgentSession } from '../runtime/session/agent-session.js'
import { AgentSessionFactory } from '../runtime/session/agent-session-factory.js'
import { TerminalUi } from './terminal-ui.js'
import { TerminalUiEventSink } from './terminal-ui-event-sink.js'

const USAGE =
  'Usage: pnpm agent --prompt <text> [--interactive] [--model mock|openai|deepseek|grok] [--workspace <path>]'

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const prompt = readFlag(argv, '--prompt')
  const interactive = argv.includes('--interactive')
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`${USAGE}\nCommands: /help /status /history /cost /plan /compact /clear /exit`)
    return 0
  }
  if (!prompt && !interactive) {
    console.error(USAGE)
    return 1
  }

  try {
    const workspacePath = readFlag(argv, '--workspace') ?? process.cwd()
    const modelName = readFlag(argv, '--model') ?? 'mock'
    const maxTurns = readNumberFlag(argv, '--max-turns', 8)
    const maxToolCalls = readNumberFlag(argv, '--max-tool-calls', 16)
    const security = createSecurityServices()
    const model = createModelProvider(modelName, { security })

    const workspace = await TemporaryWorkspaceAdapter.fromExisting(workspacePath, {
      deleteOnDispose: false,
    })
    const agent = new AgentRuntimeFactory().create({ provider: model, security })
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
                  '/help  /status  /history  /cost  /plan  /compact  /clear  /exit\nUse /plan to toggle read-only planning mode.',
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
            if (input === '/status') {
              ui?.addMessage({
                role: 'system',
                content: `Turns: ${session.history.length}; mode: ${session.isPlanMode ? 'plan' : 'execute'}`,
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
              if (turn.result.finalResponse) {
                ui?.addMessage({ role: 'assistant', content: turn.result.finalResponse })
              }
              const changedPaths = await workspace.changedPaths()
              ui?.setFileChanges(changedPaths.map((path) => ({ path, diff: '' })))
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
      }),
      task: (turnPrompt, turn) => ({
        prompt: turnPrompt,
        taskSpec: parseTaskSpec({ id: `cli-task-${turn}`, goal: turnPrompt, allowedPaths: ['.'] }),
      }),
    })
    if (argv.includes('--plan')) {
      session.togglePlanMode()
    }
    try {
      const first = prompt ? await session.submit(prompt) : undefined
      lastResult = first?.result
      if (ui) {
        if (prompt) {
          ui.addMessage({ role: 'user', content: prompt })
        }
        if (first?.result.finalResponse) {
          ui.addMessage({ role: 'assistant', content: first.result.finalResponse })
        }
        const done = new Promise<void>((resolve) => {
          finishInteractive = resolve
        })
        ui.start()
        await done
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
      await workspace.dispose()
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    console.error(USAGE)
    return 1
  }
}

const isDirect = process.argv[1]?.includes('agent-command')
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
