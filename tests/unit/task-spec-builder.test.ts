import { describe, expect, it } from 'vitest'
import type { ProjectFacts } from '../../src/runtime/project/project-facts.js'
import {
  buildInteractiveTaskSpec,
  buildTaskSpec,
} from '../../src/runtime/task/task-spec-builder.js'

const facts: ProjectFacts = {
  root: '/tmp/app',
  packageManager: 'pnpm',
  hasPackageJson: true,
  scripts: { test: 'vitest run' },
  git: { available: false, dirty: false },
}

describe('测试套件：buildTaskSpec', () => {
  it('验证：restricts allowed paths when the prompt names a file and forbids other edits', () => {
    const spec = buildTaskSpec('将 package.json 的 version 改为 2.0.0，不要改其他文件', facts)
    expect(spec.allowedPaths).toEqual(['package.json'])
    expect(spec.verificationCommands).toEqual(['pnpm test'])
  })

  it('验证：does not invent a test command unless the prompt asks to run tests', () => {
    const spec = buildTaskSpec('修复登录文案', facts)
    expect(spec.verificationCommands).toEqual([])
    expect(spec.allowedPaths).toEqual(['.'])
  })

  it('验证：does not restrict paths when a file is mentioned without a restrict hint', () => {
    const spec = buildTaskSpec('读取 package.json 并告诉我项目名', facts)
    expect(spec.allowedPaths).toEqual(['.'])
  })

  it('验证：restricts to a named file when the prompt is an edit', () => {
    const spec = buildTaskSpec('将 package.json 的 version 改为 2.0.0', facts)
    expect(spec.allowedPaths).toEqual(['package.json'])
    expect(spec.verificationCommands).toEqual(['pnpm test'])
  })

  it('验证：A-1: a read-only prompt does not add verification commands', () => {
    const spec = buildTaskSpec('读取 package.json 并告诉我项目名', facts)
    expect(spec.verificationCommands).toEqual([])
  })

  it('验证：A-2: an edit task with a real test script adds the package manager test command', () => {
    const spec = buildTaskSpec('将 src/answer.js 的 answer 改为 2', facts)
    expect(spec.verificationCommands).toEqual(['pnpm test'])
  })

  it('验证：A-3: does not invent a test command when scripts.test is missing', () => {
    const spec = buildTaskSpec('将 package.json 的 version 改为 2.0.0', {
      ...facts,
      scripts: {},
    })
    expect(spec.verificationCommands).toEqual([])
  })

  it('验证：restricts when the prompt uses an English only-edit constraint', () => {
    const spec = buildTaskSpec('edit package.json, do not change other files', facts)
    expect(spec.allowedPaths).toEqual(['package.json'])
  })

  it('验证：adds a real test command only when the prompt asks to run tests', () => {
    const spec = buildTaskSpec('改登录文案并运行测试', facts)
    expect(spec.verificationCommands).toEqual(['pnpm test'])
  })

  it('交互任务保留未写回的历史变更路径', () => {
    const spec = buildInteractiveTaskSpec(
      '将 src/new.ts 的值改为 2，不要改其他文件',
      facts,
      ['src/existing.ts', 'src/existing.ts'],
      'turn-2',
    )

    expect(spec.id).toBe('turn-2')
    expect(spec.allowedPaths).toEqual(['src/new.ts', 'src/existing.ts'])
  })

  it('交互任务已允许整个工作区时不再扩展路径', () => {
    const spec = buildInteractiveTaskSpec('修复登录文案', facts, ['src/existing.ts'])

    expect(spec.allowedPaths).toEqual(['.'])
  })
})
