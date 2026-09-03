import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TemporaryWorkspaceAdapter } from '../../packages/agent-runtime/src/workspace/temporary-workspace.js'
import { NoopEventSink } from '../../packages/core/src/events/event-sink.js'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import { createCodeDenAgent } from '../../packages/agent-runtime/src/create-codeden-runtime.js'
import {
  MockModelProvider,
  finalText,
  toolCall,
  type MockModelStep,
} from '../../packages/agent-runtime/src/models/mock-model-provider.js'
import { OpenAIModelProvider } from '../../packages/agent-runtime/src/models/openai-model-provider.js'
import { ResolvedSecret } from '../../packages/core/src/security/resolved-secret.js'
import { SecureEventSink } from '../../packages/core/src/security/secure-event-sink.js'
import { createSecurityServices } from '../../packages/core/src/security/security-services.js'
import { RunCommandTool } from '../../packages/agent-runtime/src/tools/builtins/run-command.js'
import { WorkspacePolicy } from '../../packages/agent-runtime/src/workspace/workspace-policy.js'

const SENTINEL = ['codeden', 'secret', 'must', 'never', 'appear'].join('-')

describe('secret isolation e2e', () => {
  it('E2E-1: reading .env is denied and never recorded', async () => {
    const { agent, events, workspaceRoot } = await harness([
      toolCall('read_file', { path: '.env' }),
      finalText('done'),
    ])
    await writeFile(path.join(workspaceRoot, '.env'), `DEEPSEEK_API_KEY=${SENTINEL}`, 'utf8')
    const result = await agent.run(task(), context(workspaceRoot, events.sink))
    expect(result.status).toBe('submitted')
    expect(JSON.stringify(events.items)).not.toContain(SENTINEL)
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  it('E2E-2: env command does not expose provider keys', async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = SENTINEL
    try {
      const root = await mkdtemp(path.join(tmpdir(), 'codeden-sec-'))
      const security = createSecurityServices()
      security.registry.register(new ResolvedSecret(SENTINEL))
      const output = await new RunCommandTool().execute(
        {
          command: process.execPath,
          args: ['-e', 'console.log(JSON.stringify(process.env))'],
          timeoutMs: 5000,
        },
        {
          workspaceRoot: root,
          policy: new WorkspacePolicy(root, {
            readableRoots: ['.'],
            writableRoots: ['.'],
            allowCommands: true,
          }),
          eventSink: new NoopEventSink(),
          security: {
            redactor: security.redactor,
            guard: security.guard,
            paths: security.paths,
          },
        },
      )
      const text = JSON.stringify(output)
      expect(text).not.toContain(SENTINEL)
      expect(text).not.toContain('DEEPSEEK_API_KEY')
    } finally {
      restoreEnv('DEEPSEEK_API_KEY', previous)
    }
  })

  it('E2E-3: tool errors containing the sentinel are redacted', async () => {
    const { agent, events, workspaceRoot } = await harness([
      toolCall('read_file', { path: 'note.txt' }),
      finalText('done'),
    ])
    await writeFile(path.join(workspaceRoot, 'note.txt'), SENTINEL, 'utf8')
    const result = await agent.run(task(), context(workspaceRoot, events.sink))
    expect(JSON.stringify(events.items)).not.toContain(SENTINEL)
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })

  it('E2E-4: writing a known secret is rejected', async () => {
    const { agent, workspaceRoot } = await harness([
      toolCall('write_file', { path: 'stolen.txt', content: SENTINEL }),
      finalText('done'),
    ])
    await agent.run(task(), context(workspaceRoot, new NoopEventSink()))
    await expect(readFile(path.join(workspaceRoot, 'stolen.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('E2E-5: provider transport can use the secret while agent output cannot see it', async () => {
    let usedAuth = false
    const security = createSecurityServices()
    const secret = new ResolvedSecret(SENTINEL)
    security.registry.register(secret)
    const provider = new OpenAIModelProvider({
      apiKey: secret,
      client: {
        chat: {
          completions: {
            async create() {
              usedAuth = secret.matches(SENTINEL)
              return {
                choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }
            },
          },
        },
      },
    })
    const events = createEventLog(security)
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-sec-'))
    const workspace = await TemporaryWorkspaceAdapter.fromExisting(root, { deleteOnDispose: false })
    const agent = createCodeDenAgent(provider, undefined, security)
    const result = await agent.run(task(), {
      runId: 'r',
      trialId: 't',
      workspace,
      eventSink: events.sink,
      limits: { maxTurns: 3, maxToolCalls: 3 },
      submissionType: 'text',
    })
    expect(usedAuth).toBe(true)
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(JSON.stringify(events.items)).not.toContain(SENTINEL)
  })
})

function task() {
  return { prompt: 'do it', taskSpec: parseTaskSpec({ id: 't', goal: 'g' }) }
}

function context(workspaceRoot: string, eventSink: NoopEventSink | SecureEventSink) {
  return {
    runId: 'r',
    trialId: 't',
    workspace: {
      root: workspaceRoot,
      async changedPaths() {
        return []
      },
    },
    eventSink,
    limits: { maxTurns: 5, maxToolCalls: 5 },
    submissionType: 'files' as const,
  }
}

async function harness(steps: MockModelStep[]) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'codeden-sec-'))
  const security = createSecurityServices()
  security.registry.register(new ResolvedSecret(SENTINEL))
  const events = createEventLog(security)
  const agent = createCodeDenAgent(new MockModelProvider(steps), undefined, security)
  return { agent, events, workspaceRoot, security }
}

function createEventLog(security: ReturnType<typeof createSecurityServices>) {
  const items: unknown[] = []
  const inner = {
    async emit(_source: 'agent', type: string, data: unknown) {
      items.push({ type, data })
    },
  }
  return {
    items,
    sink: new SecureEventSink(inner as never, security.redactor, security.guard),
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}
