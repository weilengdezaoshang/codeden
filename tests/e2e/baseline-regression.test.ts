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
import { captureBaseline } from '../../src/runtime/verification/baseline-recorder.js'
import { DefaultCompletionVerifier } from '../../src/runtime/verification/completion-verifier.js'

const RED_FIXTURE = 'evals/fixtures/node-test-project'
const GREEN_FIXTURE = 'evals/fixtures/node-test-green'
const TEST_CMD = 'node --test --test-reporter=tap'

describe('Baseline regression loop', { timeout: 30_000 }, () => {
  it('A-4: pre-existing failures are not treated as new regressions', async () => {
    const result = await runFixture(RED_FIXTURE, [
      toolCall('edit_file', {
        path: 'src/answer.js',
        oldText: 'answer: 1',
        newText: 'answer: 2',
      }),
      finalText('fixed target'),
    ])
    expect(result.status).toBe('verified_complete')
  })

  it('A-5: a newly broken test is not verified', async () => {
    const result = await runFixture(
      GREEN_FIXTURE,
      [
        toolCall('write_file', {
          path: 'src/ok.js',
          content: 'module.exports = { ok: 99 }\n',
        }),
        finalText('done'),
      ],
      { maxTurns: 8 },
    )
    expect(result.status).not.toBe('verified_complete')
  })

  it('A-6: the same baseline failures still verify', async () => {
    const result = await runFixture(RED_FIXTURE, [finalText('already red')])
    expect(result.status).toBe('verified_complete')
  })

  it('A-7: deleting a test file is not verified', async () => {
    const result = await runFixture(
      RED_FIXTURE,
      [
        toolCall('run_command', {
          command: process.execPath,
          args: ['-e', "require('fs').unlinkSync('tests/old-fail.test.js')"],
        }),
        finalText('deleted'),
      ],
      { maxTurns: 2 },
    )
    expect(result.status).not.toBe('verified_complete')
  })

  it('A-8: without a verifier the runner only submits', async () => {
    const workspace = await TemporaryWorkspaceAdapter.fromFixture(RED_FIXTURE)
    const agent = createCodeDenAgent(new MockModelProvider([finalText('done')]))
    const result = await agent.run(
      {
        prompt: 'fix',
        taskSpec: parseTaskSpec({
          id: 't',
          goal: 'fix',
          allowedPaths: ['src/answer.js'],
          verificationCommands: [TEST_CMD],
        }),
      },
      {
        runId: 'r',
        trialId: 't',
        workspace,
        eventSink: new NoopEventSink(),
        limits: { maxTurns: 3, maxToolCalls: 6 },
        submissionType: 'files',
      },
    )
    expect(result.status).toBe('submitted')
    await workspace.dispose()
  })
})

async function runFixture(fixture: string, steps: MockModelStep[], limits?: { maxTurns: number }) {
  const workspace = await TemporaryWorkspaceAdapter.fromFixture(fixture)
  const taskSpec = parseTaskSpec({
    id: 't',
    goal: 'fix src',
    allowedPaths: ['.'],
    verificationCommands: [TEST_CMD],
  })
  const baseline = await captureBaseline(taskSpec, workspace)
  const agent = createCodeDenAgent(
    new MockModelProvider(steps),
    undefined,
    undefined,
    new DefaultCompletionVerifier(baseline),
  )
  try {
    return await agent.run(
      { prompt: taskSpec.goal, taskSpec },
      {
        runId: 'r',
        trialId: 't',
        workspace,
        eventSink: new NoopEventSink(),
        limits: { maxTurns: limits?.maxTurns ?? 8, maxToolCalls: 8 },
        submissionType: 'files',
        allowedPaths: ['.'],
      },
    )
  } finally {
    await workspace.dispose()
  }
}
