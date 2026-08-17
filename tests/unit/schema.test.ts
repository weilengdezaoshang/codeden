import { describe, expect, it } from 'vitest'
import { getIssuePaths } from '../../src/core/errors/codeden-error.js'
import { parseTaskSpec } from '../../src/core/task/task-spec.js'
import { parseAgentSubmission } from '../../src/eval/domain/agent-submission.js'
import { parseEvalCase } from '../../src/eval/domain/eval-case.js'
import { parseTrialResult } from '../../src/eval/domain/trial-result.js'

const validCase = {
  schemaVersion: 1,
  id: 'case-1',
  suite: 'regression',
  task: {
    prompt: 'do the thing',
    taskSpec: { id: 't1', goal: 'goal' },
  },
  fixture: { path: './fixture' },
  limits: { timeoutMs: 1000, maxTurns: 3, maxToolCalls: 4 },
  submission: { type: 'files' },
  verification: { graders: [{ type: 'json-field' }] },
}

describe('schemas', () => {
  it('parses a valid eval case and applies defaults', () => {
    const parsed = parseEvalCase(validCase)
    expect(parsed.tags).toEqual([])
    expect(parsed.task.taskSpec.allowedPaths).toEqual(['.'])
    expect(parsed.submission.allowedPaths).toEqual([])
  })

  it('rejects a missing prompt and includes the field path', () => {
    try {
      parseEvalCase({
        ...validCase,
        task: { ...validCase.task, prompt: '' },
      })
      expect.unreachable()
    } catch (error) {
      expect(getIssuePaths(error).some((issue) => issue.path.includes('prompt'))).toBe(true)
    }
  })

  it('rejects illegal limits', () => {
    try {
      parseEvalCase({
        ...validCase,
        limits: { timeoutMs: 0, maxTurns: 1, maxToolCalls: 1 },
      })
      expect.unreachable()
    } catch (error) {
      expect(getIssuePaths(error).some((issue) => issue.path.includes('timeoutMs'))).toBe(true)
    }
  })

  it('rejects an unknown submission type', () => {
    expect(() => parseAgentSubmission({ type: 'blob' })).toThrow(/Invalid AgentSubmission/)
    try {
      parseEvalCase({
        ...validCase,
        submission: { type: 'git-patch' },
      })
      expect.unreachable()
    } catch (error) {
      expect(getIssuePaths(error).some((issue) => issue.path.includes('type'))).toBe(true)
    }
  })

  it('rejects an illegal TrialResult execution status', () => {
    try {
      parseTrialResult({
        schemaVersion: 1,
        runId: 'r',
        trialId: 't',
        caseId: 'c',
        execution: { status: 'verified' },
        submission: { status: 'valid' },
        verification: { status: 'passed' },
        infrastructure: { status: 'ok' },
        resolved: true,
        scores: {},
        metrics: {
          durationMs: 1,
          turns: 1,
          modelRequests: 1,
          toolCalls: 1,
          toolFailures: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      })
      expect.unreachable()
    } catch (error) {
      expect(getIssuePaths(error).some((issue) => issue.path.includes('status'))).toBe(true)
    }
  })

  it('parses a valid TaskSpec', () => {
    expect(parseTaskSpec({ id: 'a', goal: 'b' }).constraints).toEqual([])
  })
})
