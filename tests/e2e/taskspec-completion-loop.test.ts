import { describe, expect, it } from 'vitest'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { parseTaskSpec } from '../../src/core/task/task-spec.js'
import { TemporaryWorkspaceAdapter } from '../../src/eval/adapters/workspaces/temporary-workspace.adapter.js'
import { createCodeDenAgent } from '../../src/runtime/create-codeden-runtime.js'
import {
  MockModelProvider,
  finalText,
  toolCall,
  type MockModelStep,
} from '../../src/runtime/models/mock-model-provider.js'
import { DefaultCompletionVerifier } from '../../src/runtime/verification/completion-verifier.js'

const FIXTURE = 'evals/fixtures/basic-node-project'
const TASK = parseTaskSpec({
  id: 'update-package-version',
  goal: '将 package.json 的 version 改为 2.0.0，不要改其他文件',
  allowedPaths: ['package.json'],
  constraints: ['不得修改其他文件'],
})

describe('TaskSpec completion loop', () => {
  it('A-2: claiming complete without edits is not verified', async () => {
    const result = await runWithSteps([finalText('已完成')], { maxTurns: 1 })
    expect(result.status).not.toBe('verified_complete')
    expect(result.status).not.toBe('submitted')
    expect(result.status).toBe('budget_exhausted')
  })

  it('A-3: extra file changes are not verified', async () => {
    const result = await runWithSteps(
      [
        toolCall('edit_file', {
          path: 'package.json',
          oldText: '"version": "1.0.0"',
          newText: '"version": "2.0.0"',
        }),
        toolCall('run_command', {
          command: process.execPath,
          args: ['-e', "require('fs').writeFileSync('README.md', 'extra')"],
        }),
        finalText('done'),
      ],
      { maxTurns: 3 },
    )
    expect(result.status).not.toBe('verified_complete')
    expect(result.status).toBe('budget_exhausted')
  })

  it('A-4: a correct edit is verified complete', async () => {
    const result = await runWithSteps([
      toolCall('read_file', { path: 'package.json' }),
      toolCall('edit_file', {
        path: 'package.json',
        oldText: '"version": "1.0.0"',
        newText: '"version": "2.0.0"',
      }),
      finalText('已完成版本修改'),
    ])
    expect(result.status).toBe('verified_complete')
  })

  it('A-5: failed verification can be repaired on the next turn', async () => {
    const result = await runWithSteps(
      [
        finalText('已完成'),
        toolCall('edit_file', {
          path: 'package.json',
          oldText: '"version": "1.0.0"',
          newText: '"version": "2.0.0"',
        }),
        finalText('已修好'),
      ],
      { maxTurns: 5 },
    )
    expect(result.status).toBe('verified_complete')
  })

  it('A-6: exhausting turns without a valid change is not success', async () => {
    const result = await runWithSteps(
      [finalText('已完成'), finalText('还是完成'), finalText('完成')],
      {
        maxTurns: 2,
      },
    )
    expect(result.status).toBe('budget_exhausted')
    expect(result.status).not.toBe('verified_complete')
  })

  it('A-7: without a verifier the runner only submits', async () => {
    const workspace = await TemporaryWorkspaceAdapter.fromFixture(FIXTURE)
    const agent = createCodeDenAgent(new MockModelProvider([finalText('已完成')]))
    const result = await agent.run(
      { prompt: TASK.goal, taskSpec: TASK },
      {
        runId: 'r',
        trialId: 't',
        workspace,
        eventSink: new NoopEventSink(),
        limits: { maxTurns: 3, maxToolCalls: 6 },
        submissionType: 'files',
        allowedPaths: TASK.allowedPaths,
      },
    )
    expect(result.status).toBe('submitted')
    await workspace.dispose()
  })
})

async function runWithSteps(steps: MockModelStep[], limits?: { maxTurns: number }) {
  const workspace = await TemporaryWorkspaceAdapter.fromFixture(FIXTURE)
  const agent = createCodeDenAgent(
    new MockModelProvider(steps),
    undefined,
    undefined,
    new DefaultCompletionVerifier(),
  )
  try {
    return await agent.run(
      { prompt: TASK.goal, taskSpec: TASK },
      {
        runId: 'r',
        trialId: 't',
        workspace,
        eventSink: new NoopEventSink(),
        limits: { maxTurns: limits?.maxTurns ?? 8, maxToolCalls: 8 },
        submissionType: 'files',
        allowedPaths: TASK.allowedPaths,
      },
    )
  } finally {
    await workspace.dispose()
  }
}
