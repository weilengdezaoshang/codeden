import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TemporaryWorkspaceAdapter } from '../../src/eval/adapters/workspaces/temporary-workspace.adapter.js'
import { ChangedPathsGrader } from '../../src/eval/graders/changed-paths.grader.js'
import { CommandGrader } from '../../src/eval/graders/command.grader.js'
import { JsonFieldGrader } from '../../src/eval/graders/json-field.grader.js'
import { UnchangedPathsGrader } from '../../src/eval/graders/unchanged-paths.grader.js'

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
})
