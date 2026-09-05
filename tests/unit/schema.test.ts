import { describe, expect, it } from 'vitest'
import { getIssuePaths } from '../../packages/core/src/errors/codeden-error.js'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import { parseAgentSubmission } from '../../packages/core/src/agent-submission.js'
import { parseEvalCase } from '../../packages/eval-engine/src/domain/eval-case.js'
import { parseTrialResult } from '../../packages/eval-engine/src/domain/trial-result.js'
import { parseCodeDenConfig } from '../../packages/core/src/config/config-validator.js'

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

describe('测试套件：schemas', () => {
  it('验证：parses a valid eval case and applies defaults', () => {
    const parsed = parseEvalCase(validCase)
    expect(parsed.tags).toEqual([])
    expect(parsed.task.taskSpec.allowedPaths).toEqual(['.'])
    expect(parsed.submission.allowedPaths).toEqual([])
  })

  it('验证：解析评测用人格指令并拒绝过长内容', () => {
    expect(parseEvalCase({ ...validCase, persona: { instruction: '简洁、直接' } }).persona).toEqual(
      { instruction: '简洁、直接', source: 'eval-case' },
    )
    expect(() =>
      parseEvalCase({ ...validCase, persona: { instruction: 'x'.repeat(4_001) } }),
    ).toThrow('Invalid EvalCase')
  })

  it('验证：rejects a missing prompt and includes the field path', () => {
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

  it('验证：rejects illegal limits', () => {
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

  it('验证：rejects an unknown submission type', () => {
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

  it('验证：rejects an illegal TrialResult execution status', () => {
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

  it('验证：parses a valid TaskSpec', () => {
    expect(parseTaskSpec({ id: 'a', goal: 'b' }).constraints).toEqual([])
  })

  it('验证：解析 MCP 配置并允许环境变量引用', () => {
    const config = parseCodeDenConfig({
      schemaVersion: 1,
      agent: { defaultProvider: 'local' },
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'https://example.com/v1',
          apiKey: { from: 'env', name: 'MODEL_KEY' },
          defaultModel: 'test',
          capabilities: { tools: true },
        },
      },
      mcp: {
        servers: {
          docs: {
            command: 'node',
            env: { API_TOKEN: { from: 'env', name: 'MCP_TOKEN' } },
          },
        },
      },
    })
    expect(config.mcp.servers.docs?.env.API_TOKEN).toEqual({ from: 'env', name: 'MCP_TOKEN' })
  })

  it('验证：折叠开关缺省关闭，可显式开启', () => {
    const base = {
      schemaVersion: 1,
      agent: { defaultProvider: 'local' },
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'https://example.com/v1',
          apiKey: { from: 'env', name: 'MODEL_KEY' },
          defaultModel: 'test',
          capabilities: { tools: true },
        },
      },
    }
    expect(parseCodeDenConfig(base).agent.folding.enabled).toBe(false)
    expect(
      parseCodeDenConfig({
        ...base,
        agent: { defaultProvider: 'local', folding: { enabled: true } },
      }).agent.folding.enabled,
    ).toBe(true)
  })

  it('验证：解析 SSE MCP 配置和请求头引用', () => {
    const config = parseCodeDenConfig({
      schemaVersion: 1,
      agent: { defaultProvider: 'local' },
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'https://example.com/v1',
          apiKey: { from: 'env', name: 'MODEL_KEY' },
          defaultModel: 'test',
          capabilities: { tools: true },
        },
      },
      mcp: {
        servers: {
          remote: {
            transport: 'sse',
            url: 'https://mcp.example.com/sse',
            headers: { Authorization: { from: 'env', name: 'MCP_TOKEN' } },
          },
        },
      },
    })

    expect(config.mcp.servers.remote?.transport).toBe('sse')
    expect(config.mcp.servers.remote?.url).toBe('https://mcp.example.com/sse')
  })

  it('验证：拒绝缺少 command 或 url 的 MCP 配置', () => {
    expect(() =>
      parseCodeDenConfig({
        schemaVersion: 1,
        agent: { defaultProvider: 'local' },
        providers: {
          local: {
            type: 'openai-compatible',
            baseURL: 'https://example.com/v1',
            apiKey: { from: 'env', name: 'MODEL_KEY' },
            defaultModel: 'test',
            capabilities: { tools: true },
          },
        },
        mcp: { servers: { broken: { transport: 'stdio' } } },
      }),
    ).toThrow()
    expect(() =>
      parseCodeDenConfig({
        schemaVersion: 1,
        agent: { defaultProvider: 'local' },
        providers: {
          local: {
            type: 'openai-compatible',
            baseURL: 'https://example.com/v1',
            apiKey: { from: 'env', name: 'MODEL_KEY' },
            defaultModel: 'test',
            capabilities: { tools: true },
          },
        },
        mcp: { servers: { broken: { transport: 'sse' } } },
      }),
    ).toThrow()
  })
})
