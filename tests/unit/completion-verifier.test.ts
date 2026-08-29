import { describe, expect, it } from 'vitest'
import { parseTaskSpec } from '../../src/core/task/task-spec.js'
import type { AgentWorkspaceView } from '../../src/eval/ports/agent.port.js'
import { DefaultCompletionVerifier } from '../../src/runtime/verification/completion-verifier.js'
import { verifyDiffPolicy } from '../../src/runtime/verification/diff-policy-verifier.js'

const spec = parseTaskSpec({
  id: 't',
  goal: 'edit package.json',
  allowedPaths: ['package.json'],
})

describe('测试套件：verifyDiffPolicy', () => {
  it('验证：fails when nothing changed', () => {
    const result = verifyDiffPolicy(spec, [])
    expect(result.passed).toBe(false)
  })

  it('验证：fails when extra files change', () => {
    const result = verifyDiffPolicy(spec, ['package.json', 'README.md'])
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain('README.md')
  })

  it('验证：passes when only allowed files change', () => {
    const result = verifyDiffPolicy(spec, ['package.json'])
    expect(result.passed).toBe(true)
  })

  it('验证：ignores git-internal paths when judging extras', () => {
    const result = verifyDiffPolicy(spec, ['package.json', '.git/index'])
    expect(result.passed).toBe(true)
    expect(result.evidence).toEqual(['package.json'])
  })

  it('验证：fails when a sensitive path changed even if allowedPaths is the workspace root', () => {
    const openSpec = parseTaskSpec({ id: 't', goal: 'edit files', allowedPaths: ['.'] })
    const result = verifyDiffPolicy(openSpec, ['.env'])
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain('.env')
  })
})

describe('测试套件：DefaultCompletionVerifier', () => {
  it('验证：fails when the workspace cannot run required commands', async () => {
    const workspace: AgentWorkspaceView = {
      root: '/tmp',
      changedPaths: async () => ['package.json'],
    }
    const result = await new DefaultCompletionVerifier().verify(
      parseTaskSpec({
        id: 't',
        goal: 'edit package.json',
        allowedPaths: ['package.json'],
        verificationCommands: ['pnpm test'],
      }),
      workspace,
    )
    expect(result.passed).toBe(false)
    expect(result.message).toContain('cannot execute')
  })

  it('验证：passes diff and command checks together', async () => {
    const workspace: AgentWorkspaceView = {
      root: '/tmp',
      changedPaths: async () => ['package.json'],
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    }
    const result = await new DefaultCompletionVerifier().verify(
      parseTaskSpec({
        id: 't',
        goal: 'edit package.json',
        allowedPaths: ['package.json'],
        verificationCommands: ['pnpm test'],
      }),
      workspace,
    )
    expect(result.passed).toBe(true)
  })

  it('验证命令产生越界文件时拒绝通过', async () => {
    let changedPaths = ['package.json']
    const workspace: AgentWorkspaceView = {
      root: '/tmp',
      changedPaths: async () => changedPaths,
      exec: async () => {
        changedPaths = ['package.json', 'unexpected.log']
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
      },
    }

    const result = await new DefaultCompletionVerifier().verify(
      parseTaskSpec({
        id: 't',
        goal: 'edit package.json',
        allowedPaths: ['package.json'],
        verificationCommands: ['pnpm test'],
      }),
      workspace,
    )

    expect(result.passed).toBe(false)
    expect(result.evidence).toContain('unexpected.log')
  })
})
