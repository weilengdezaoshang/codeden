import { NoopEventSink } from '../core/events/event-sink.js'
import { TemporaryWorkspaceAdapter } from '../eval/adapters/workspaces/temporary-workspace.adapter.js'
import { createCodeDenAgent } from '../runtime/create-codeden-runtime.js'
import { createModelProvider } from '../runtime/models/create-model-provider.js'
import { parseTaskSpec } from '../core/task/task-spec.js'
import { readFlag, readNumberFlag } from './args.js'

const USAGE =
  'Usage: pnpm agent --prompt <text> [--model mock|openai|deepseek|grok] [--workspace <path>]'

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
    const model = createModelProvider(modelName)

    const workspace = await TemporaryWorkspaceAdapter.fromExisting(workspacePath, {
      deleteOnDispose: false,
    })
    const agent = createCodeDenAgent(model)
    const result = await agent.run(
      {
        prompt,
        taskSpec: parseTaskSpec({
          id: 'cli-task',
          goal: prompt,
          allowedPaths: ['.'],
        }),
      },
      {
        runId: 'cli',
        trialId: 'cli',
        workspace,
        eventSink: new NoopEventSink(),
        limits: { maxTurns, maxToolCalls },
        submissionType: 'files',
        allowedPaths: ['.'],
      },
    )

    console.log(`Status: ${result.status}`)
    if (result.finalResponse) {
      console.log(result.finalResponse)
    }
    if (result.submission) {
      console.log(`Submission: ${JSON.stringify(result.submission)}`)
    }
    return result.status === 'submitted' ? 0 : 1
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
