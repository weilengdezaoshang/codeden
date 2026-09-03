import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TemporaryWorkspaceAdapter } from '../../packages/agent-runtime/src/workspace/temporary-workspace.js'

describe('工作区文件 Diff', () => {
  it('验证：为变更文件记录修改前后的文本', async () => {
    const workspace = await TemporaryWorkspaceAdapter.fromFixture(
      path.resolve('evals/fixtures/basic-node-project'),
    )
    try {
      const before = await workspace.readFile('package.json')
      await workspace.writeFile('package.json', before.replace('1.0.0', '2.0.0'))

      await expect(workspace.changedPaths()).resolves.toEqual(['package.json'])
      await expect(workspace.fileDiffs()).resolves.toEqual([
        {
          path: 'package.json',
          before,
          after: before.replace('1.0.0', '2.0.0'),
        },
      ])
    } finally {
      await workspace.dispose()
    }
  })

  it('验证：标记删除文件以供隔离验证器重现提交', async () => {
    const workspace = await TemporaryWorkspaceAdapter.fromFixture(
      path.resolve('evals/fixtures/basic-node-project'),
    )
    try {
      const before = await workspace.readFile('package.json')
      await workspace.deleteFile('package.json')
      await expect(workspace.fileDiffs()).resolves.toEqual([
        { path: 'package.json', before, after: '', deleted: true },
      ])
    } finally {
      await workspace.dispose()
    }
  })
})
