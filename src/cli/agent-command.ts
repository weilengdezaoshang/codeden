import { NoopEventSink } from '../core/events/event-sink.js'
import { TemporaryWorkspaceAdapter } from '../eval/adapters/workspaces/temporary-workspace.adapter.js'
import { createCodeDenAgent } from '../runtime/create-codeden-runtime.js'
import { createModelProvider } from '../runtime/models/create-model-provider.js'
import { SecureEventSink } from '../security/secure-event-sink.js'
import { createSecurityServices } from '../security/security-services.js'
import { parseTaskSpec } from '../core/task/task-spec.js'
import { readFlag, readNumberFlag } from './args.js'
import readline from 'node:readline/promises'
import { AgentSession } from '../runtime/session/agent-session.js'

const USAGE =
  'Usage: pnpm agent --prompt <text> [--interactive] [--model mock|openai|deepseek|grok] [--workspace <path>]'

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const prompt = readFlag(argv, '--prompt')
  if (!prompt) {
    console.error(USAGE)
    return 1
  }

  try {
    const workspacePath = readFlag(argv, '--workspace') ?? process.cwd()
    const modelName = readFlag(argv, '--model') ?? 'mock'
    const maxTurns = readNumberFlag(argv, '--max-turns', 8)
    const maxToolCalls = readNumberFlag(argv, '--max-tool-calls', 16)
    const interactive = argv.includes('--interactive')
    const security = createSecurityServices()
    const model = createModelProvider(modelName, { security })

    const workspace = await TemporaryWorkspaceAdapter.fromExisting(workspacePath, {
      deleteOnDispose: false,
    })
    const agent = createCodeDenAgent(model, undefined, security)
    const eventSink = new SecureEventSink(new NoopEventSink(), security.redactor, security.guard)
    const session = new AgentSession(
      agent,
      (_turnPrompt, turn) => ({
        runId: `cli-${turn}`,
        trialId: `cli-${turn}`,
        workspace,
        eventSink,
        limits: { maxTurns, maxToolCalls },
        submissionType: 'files',
        allowedPaths: ['.'],
      }),
      (turnPrompt, turn) => ({
        prompt: turnPrompt,
        taskSpec: parseTaskSpec({ id: `cli-task-${turn}`, goal: turnPrompt, allowedPaths: ['.'] }),
      }),
    )
    try {
      const first = await session.submit(prompt)
      let result = first.result
      if (interactive) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        try {
          while (true) {
            const next = (await rl.question('\nYou › ')).trim()
            if (!next || next === '/exit' || next === '/quit') {
              break
            }
            const turn = await session.submit(next)
            result = turn.result
            console.log(`\nStatus: ${result.status}`)
            if (result.finalResponse) {
              console.log(result.finalResponse)
            }
          }
        } finally {
          rl.close()
        }
      }

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
