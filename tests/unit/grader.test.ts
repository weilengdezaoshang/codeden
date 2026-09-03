import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TemporaryWorkspaceAdapter } from '../../packages/agent-runtime/src/workspace/temporary-workspace.js'
import { ChangedPathsGrader } from '../../packages/eval-engine/src/graders/changed-paths.grader.js'
import { CommandGrader } from '../../packages/eval-engine/src/graders/command.grader.js'
import { JsonFieldGrader } from '../../packages/eval-engine/src/graders/json-field.grader.js'
import { UnchangedPathsGrader } from '../../packages/eval-engine/src/graders/unchanged-paths.grader.js'
import { PersonaRubricGrader } from '../../packages/eval-engine/src/graders/persona-rubric.grader.js'

async function workspaceWith(files: Record<string, string>): Promise<TemporaryWorkspaceAdapter> {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-grader-'))
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(root, rel), content, 'utf8')
  }
  return TemporaryWorkspaceAdapter.fromExisting(root, {
    deleteOnDispose: false,
    allowVerificationCommands: true,
  })
}

describe('测试套件：graders', () => {
  it('验证：passes when a JSON field equals the expected value', async () => {
    const workspace = await workspaceWith({ 'package.json': '{"version":"2.0.0"}' })
    const result = await new JsonFieldGrader().grade(
      { type: 'json-field', path: 'package.json', pointer: '/version', equals: '2.0.0' },
      { workspace },
    )
    expect(result.passed).toBe(true)
  })

  it('验证：fails when a JSON field does not match', async () => {
    const workspace = await workspaceWith({ 'package.json': '{"version":"1.0.0"}' })
    const result = await new JsonFieldGrader().grade(
      { type: 'json-field', path: 'package.json', pointer: '/version', equals: '2.0.0' },
      { workspace },
    )
    expect(result.passed).toBe(false)
    expect(result.evidence[0]).toContain('1.0.0')
  })

  it('验证：fails on invalid JSON', async () => {
    const workspace = await workspaceWith({ 'package.json': '{oops' })
    const result = await new JsonFieldGrader().grade(
      { type: 'json-field', path: 'package.json', pointer: '/version', equals: '2.0.0' },
      { workspace },
    )
    expect(result.passed).toBe(false)
    expect(result.message).toMatch(/Invalid JSON/)
  })

  it('验证：fails when the file does not exist', async () => {
    const workspace = await workspaceWith({ 'keep.txt': 'x' })
    const result = await new JsonFieldGrader().grade(
      { type: 'json-field', path: 'package.json', pointer: '/version', equals: '2.0.0' },
      { workspace },
    )
    expect(result.passed).toBe(false)
    expect(result.message).toMatch(/not found/i)
  })

  it('验证：fails when extra files change', async () => {
    const workspace = await workspaceWith({
      'package.json': '{"version":"1.0.0"}',
      'README.md': 'a',
    })
    await workspace.writeFile('README.md', 'changed')
    const result = await new ChangedPathsGrader().grade(
      { type: 'changed-paths', allowed: ['package.json'] },
      { workspace },
    )
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain('README.md')
  })

  it('验证：grades a command from its exit code and captures evidence', async () => {
    const workspace = await workspaceWith({ 'keep.txt': 'x' })
    const result = await new CommandGrader().grade(
      {
        type: 'command',
        command: process.execPath,
        args: ['-e', "console.log('verified')"],
        expectedExitCode: 0,
      },
      { workspace },
    )
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain('verified\n')
  })

  it('验证：rejects verification commands unless the workspace explicitly allows them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-grader-denied-'))
    await writeFile(path.join(root, 'keep.txt'), 'x')
    const workspace = await TemporaryWorkspaceAdapter.fromExisting(root)
    await expect(
      new CommandGrader().grade(
        {
          type: 'command',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          expectedExitCode: 0,
        },
        { workspace },
      ),
    ).rejects.toThrow('disabled')
  })

  it('验证：fails when a protected test path changes', async () => {
    const workspace = await workspaceWith({ 'test_case.py': 'assert True' })
    await workspace.writeFile('test_case.py', 'assert False')
    const result = await new UnchangedPathsGrader().grade(
      { type: 'unchanged-paths', paths: ['test_case.py'] },
      { workspace },
    )
    expect(result.passed).toBe(false)
    expect(result.evidence).toEqual(['test_case.py'])
  })

  it('验证：人格评分拒绝空回复以及重复规则编号', async () => {
    const workspace = await workspaceWith({ 'keep.txt': 'x' })
    const criterion = { id: 'short', kind: 'max_chars' as const, value: 20, weight: 1 }
    const config = { type: 'persona-rubric' as const, threshold: 1, criteria: [criterion] }
    expect((await new PersonaRubricGrader().grade(config, { workspace })).passed).toBe(false)
    await expect(
      new PersonaRubricGrader().grade(
        { ...config, criteria: [criterion, criterion] },
        { workspace, finalResponse: '完成' },
      ),
    ).rejects.toThrow()
  })

  it('验证：关键人格规则失败不能被其他得分抵消', async () => {
    const workspace = await workspaceWith({ 'keep.txt': 'x' })
    const result = await new PersonaRubricGrader().grade(
      {
        type: 'persona-rubric',
        threshold: 0.1,
        criteria: [
          { id: 'short', kind: 'max_chars', value: 100, weight: 100 },
          {
            id: 'no-flattery',
            kind: 'not_contains',
            value: '很棒',
            weight: 1,
            critical: true,
            caseSensitive: false,
          },
        ],
      },
      { workspace, finalResponse: '很棒的问题' },
    )
    expect(result.score).toBeGreaterThan(0.9)
    expect(result.passed).toBe(false)
  })

  it('验证：按权重评估人格风格并返回未通过的规则', async () => {
    const workspace = await workspaceWith({ 'keep.txt': 'x' })
    const grader = new PersonaRubricGrader()
    const config = {
      type: 'persona-rubric' as const,
      threshold: 0.8,
      criteria: [
        { id: 'concise', kind: 'max_chars' as const, value: 20, weight: 2 },
        {
          id: 'polite',
          kind: 'contains' as const,
          value: '请',
          weight: 1,
          caseSensitive: false,
        },
        {
          id: 'no-fluff',
          kind: 'not_contains' as const,
          value: '很棒的问题',
          weight: 1,
          caseSensitive: false,
        },
      ],
    }

    expect((await grader.grade(config, { workspace, finalResponse: '请运行测试。' })).passed).toBe(
      true,
    )
    const failed = await grader.grade(config, {
      workspace,
      finalResponse: '这是一个很棒的问题，我将用非常详细的方式长篇解释。',
    })
    expect(failed.passed).toBe(false)
    expect(failed.evidence).toEqual(
      expect.arrayContaining(['criterion:concise', 'criterion:polite']),
    )
  })
})
