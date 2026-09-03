import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseTaskSpec } from '../../packages/core/src/task/task-spec.js'
import {
  RevisionBoundCompletionVerifier,
  createVerifiedWorkspaceSnapshot,
  parseVerifiedWorkspaceSnapshot,
} from '../../packages/agent-runtime/src/attempts/verified-workspace-snapshot.js'
import { WritebackGate } from '../../packages/agent-runtime/src/workspace/writeback-gate.js'

describe('测试套件：已验证工作区快照', () => {
  it('验证通过时捕获当时的文件版本', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-verified-'))
    try {
      await writeFile(path.join(root, 'answer.ts'), 'export const answer = 42\n')
      const delegate = {
        verify: vi.fn(async () => ({ passed: true, message: 'ok', evidence: [] })),
      }
      const verifier = new RevisionBoundCompletionVerifier(delegate, {
        attemptId: 'attempt-1',
        baseCommit: 'base-commit',
      })
      const task = parseTaskSpec({ id: 'task-1', goal: '修复', allowedPaths: ['answer.ts'] })

      const result = await verifier.verify(task, workspace(root, ['answer.ts']))

      expect(result.verifiedSnapshot).toMatchObject({
        attemptId: 'attempt-1',
        taskSpecId: 'task-1',
        revision: { baseCommit: 'base-commit' },
      })
      expect(parseVerifiedWorkspaceSnapshot(result.verifiedSnapshot)).toEqual(
        result.verifiedSnapshot,
      )
      expect(() =>
        parseVerifiedWorkspaceSnapshot({
          ...result.verifiedSnapshot,
          revision: { ...result.verifiedSnapshot?.revision, id: '0'.repeat(64) },
        }),
      ).toThrow('Workspace revision digest does not match its manifest')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('验证失败时不生成可写回快照', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-verified-'))
    try {
      const verifier = new RevisionBoundCompletionVerifier(
        {
          async verify() {
            return { passed: false, message: 'failed', evidence: [] }
          },
        },
        { attemptId: 'attempt-2' },
      )

      const result = await verifier.verify(
        parseTaskSpec({ id: 'task-2', goal: '修复' }),
        workspace(root, []),
      )

      expect(result.verifiedSnapshot).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('工作区在验证后变化时拒绝写回', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-verified-'))
    try {
      await writeFile(path.join(root, 'answer.ts'), 'before\n')
      const currentWorkspace = workspace(root, ['answer.ts'])
      const snapshot = await createVerifiedWorkspaceSnapshot({
        attemptId: 'attempt-3',
        taskSpecId: 'task-3',
        workspace: currentWorkspace,
      })
      await writeFile(path.join(root, 'answer.ts'), 'after\n')

      await expect(
        new WritebackGate().assertCurrent(snapshot, currentWorkspace),
      ).rejects.toMatchObject({ code: 'WORKSPACE_REVISION_STALE' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('快照与当前会话的基础提交不同时拒绝写回', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-verified-'))
    try {
      await writeFile(path.join(root, 'answer.ts'), 'verified\n')
      const currentWorkspace = workspace(root, ['answer.ts'])
      const snapshot = await createVerifiedWorkspaceSnapshot({
        attemptId: 'attempt-4',
        taskSpecId: 'task-4',
        workspace: currentWorkspace,
        baseCommit: 'old-base',
      })

      await expect(
        new WritebackGate().assertCurrent(snapshot, currentWorkspace, {
          baseCommit: 'new-base',
        }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_REVISION_STALE' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function workspace(root: string, changedPaths: string[]) {
  return {
    root,
    async changedPaths() {
      return changedPaths
    },
  }
}
