import { describe, expect, it } from 'vitest'
import type { ProjectFacts } from '../../src/runtime/project/project-facts.js'
import { buildTaskSpec } from '../../src/runtime/task/task-spec-builder.js'

const facts: ProjectFacts = {
  root: '/tmp/app',
  packageManager: 'pnpm',
  hasPackageJson: true,
  scripts: { test: 'vitest run' },
  git: { available: false, dirty: false },
}

describe('buildTaskSpec', () => {
  it('restricts allowed paths when the prompt names a file and forbids other edits', () => {
    const spec = buildTaskSpec('将 package.json 的 version 改为 2.0.0，不要改其他文件', facts)
    expect(spec.allowedPaths).toEqual(['package.json'])
    expect(spec.verificationCommands).toEqual([])
  })

  it('does not invent a test command unless the prompt asks to run tests', () => {
    const spec = buildTaskSpec('修复登录文案', facts)
    expect(spec.verificationCommands).toEqual([])
    expect(spec.allowedPaths).toEqual(['.'])
  })

  it('does not restrict paths when a file is mentioned without a restrict hint', () => {
    const spec = buildTaskSpec('读取 package.json 并告诉我项目名', facts)
    expect(spec.allowedPaths).toEqual(['.'])
  })

  it('restricts to a named file when the prompt is an edit', () => {
    const spec = buildTaskSpec('将 package.json 的 version 改为 2.0.0', facts)
    expect(spec.allowedPaths).toEqual(['package.json'])
  })

  it('restricts when the prompt uses an English only-edit constraint', () => {
    const spec = buildTaskSpec('edit package.json, do not change other files', facts)
    expect(spec.allowedPaths).toEqual(['package.json'])
  })

  it('adds a real test command only when the prompt asks to run tests', () => {
    const spec = buildTaskSpec('改登录文案并运行测试', facts)
    expect(spec.verificationCommands).toEqual(['pnpm test'])
  })
})
