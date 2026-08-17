import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TemporaryWorkspaceAdapter } from '../../src/eval/adapters/workspaces/temporary-workspace.adapter.js'
import { ChangedPathsGrader } from '../../src/eval/graders/changed-paths.grader.js'
import { JsonFieldGrader } from '../../src/eval/graders/json-field.grader.js'

async function workspaceWith(files: Record<string, string>): Promise<TemporaryWorkspaceAdapter> {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-grader-'))
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(root, rel), content, 'utf8')
  }
  return TemporaryWorkspaceAdapter.fromExisting(root, { deleteOnDispose: false })
}

describe('graders', () => {
  it('passes when a JSON field equals the expected value', async () => {
    const workspace = await workspaceWith({ 'package.json': '{"version":"2.0.0"}' })
    const result = await new JsonFieldGrader().grade(
      { type: 'json-field', path: 'package.json', pointer: '/version', equals: '2.0.0' },
      { workspace },
    )
    expect(result.passed).toBe(true)
  })

  it('fails when a JSON field does not match', async () => {
    const workspace = await workspaceWith({ 'package.json': '{"version":"1.0.0"}' })
    const result = await new JsonFieldGrader().grade(
      { type: 'json-field', path: 'package.json', pointer: '/version', equals: '2.0.0' },
      { workspace },
    )
    expect(result.passed).toBe(false)
    expect(result.evidence[0]).toContain('1.0.0')
  })

  it('fails on invalid JSON', async () => {
    const workspace = await workspaceWith({ 'package.json': '{oops' })
    const result = await new JsonFieldGrader().grade(
      { type: 'json-field', path: 'package.json', pointer: '/version', equals: '2.0.0' },
      { workspace },
    )
    expect(result.passed).toBe(false)
    expect(result.message).toMatch(/Invalid JSON/)
  })

  it('fails when the file does not exist', async () => {
    const workspace = await workspaceWith({ 'keep.txt': 'x' })
    const result = await new JsonFieldGrader().grade(
      { type: 'json-field', path: 'package.json', pointer: '/version', equals: '2.0.0' },
      { workspace },
    )
    expect(result.passed).toBe(false)
    expect(result.message).toMatch(/not found/i)
  })

  it('fails when extra files change', async () => {
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
})
