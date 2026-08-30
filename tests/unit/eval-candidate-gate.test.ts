import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CandidateDatasetStore } from '../../src/eval/candidates/candidate-dataset-store.js'
import {
  createEvalCandidate,
  evaluateCandidateGate,
  parseEvalCandidate,
} from '../../src/eval/candidates/eval-candidate.js'

describe('测试套件：评测候选样本门禁', () => {
  it('独立 fixture 通过隐私、复现、去重和人工复审后才接收', () => {
    const candidate = parseEvalCandidate(validCandidate())

    const decision = evaluateCandidateGate(candidate, new Set())

    expect(decision.status).toBe('accepted')
    expect(decision.checks.every((check) => !check.blocking || check.passed)).toBe(true)
  })

  it('原始用户代码、不可复现或未完成复审时拒绝候选', () => {
    const input = validCandidateInput()
    const candidate = createEvalCandidate({
      ...input,
      fixture: { ...input.fixture, containsUserCode: true },
      reproduction: { ...input.reproduction, runs: 1, successes: 1 },
      humanReview: { required: true, status: 'pending' },
    })

    const decision = evaluateCandidateGate(candidate, new Set())

    expect(decision.status).toBe('rejected')
    expect(
      decision.checks.filter((check) => check.blocking && !check.passed).map((item) => item.id),
    ).toEqual(
      expect.arrayContaining(['privacy.no_user_code', 'reproduction.stable', 'review.completed']),
    )
  })

  it('与已有评测集指纹重复时拒绝候选', () => {
    const candidate = parseEvalCandidate(validCandidate())

    const decision = evaluateCandidateGate(candidate, new Set([candidate.fingerprint]))

    expect(decision.status).toBe('rejected')
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ id: 'dataset.unique', passed: false, blocking: true }),
    )
  })

  it('授权信息为未知值时拒绝候选', () => {
    const input = validCandidateInput()
    const candidate = createEvalCandidate({
      ...input,
      fixture: { ...input.fixture, license: ' Unknown ' },
    })

    const decision = evaluateCandidateGate(candidate, new Set())

    expect(decision.status).toBe('rejected')
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ id: 'fixture.licensed', passed: false, blocking: true }),
    )
  })

  it('候选数据结构拒绝携带原始 Trace 正文', () => {
    expect(() =>
      parseEvalCandidate({ ...validCandidate(), rawTrace: { prompt: 'private' } }),
    ).toThrow('Invalid eval candidate')
  })

  it('只有通过门禁的候选才原子写入离线评测集', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-candidates-'))
    try {
      const store = candidateStore(root)

      const decision = await store.promote(validCandidate(), 'trusted')

      expect(decision.status).toBe('accepted')
      expect((await store.listCases()).map((evalCase) => evalCase.id)).toEqual(['case-1'])
      const file = path.join(root, '.codeden', 'evals', 'candidates', 'candidate-1.json')
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
        fingerprint: expect.any(String),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝未通过隐私门禁和指纹重复的候选', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-candidates-'))
    try {
      const store = candidateStore(root)
      const unsafeInput = validCandidateInput()
      const unsafe = createEvalCandidate({
        ...unsafeInput,
        id: 'candidate-unsafe',
        privacy: { ...unsafeInput.privacy, status: 'rejected', findingCount: 1 },
      })

      expect((await store.promote(unsafe, 'trusted')).status).toBe('rejected')
      expect((await store.promote(validCandidate(), 'trusted')).status).toBe('accepted')
      expect((await store.promote(validCandidate(), 'trusted')).status).toBe('rejected')
      expect(await store.listCases()).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('评测集记录损坏时失败关闭而不是忽略样本', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-candidates-'))
    try {
      const store = candidateStore(root)
      await store.promote(validCandidate(), 'trusted')
      await writeFile(
        path.join(root, '.codeden', 'evals', 'candidates', 'candidate-1.json'),
        '{invalid',
      )

      await expect(store.listCases()).rejects.toThrow('Invalid candidate dataset record')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝可以逃逸数据集目录的候选编号', () => {
    expect(() => createEvalCandidate({ ...validCandidateInput(), id: '../outside' })).toThrow(
      'Invalid eval candidate',
    )
  })

  it('权威隐私和复现凭证校验失败时不能仅靠候选字段通过门禁', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-candidates-'))
    try {
      const store = candidateStore(root)

      const decision = await store.promote(validCandidate(), 'forged')

      expect(decision.status).toBe('rejected')
      expect(decision.checks).toContainEqual(
        expect.objectContaining({ id: 'evidence.receipt', passed: false, blocking: true }),
      )
      expect(await store.listCases()).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function candidateStore(root: string) {
  return new CandidateDatasetStore(root, {
    verify: async (_candidate, receipt) => ({
      passed: receipt === 'trusted',
      checks: [
        {
          id: 'receipt',
          passed: receipt === 'trusted',
          message: '必须验证权威隐私、复现和人工复审凭证',
        },
      ],
    }),
  })
}

function validCandidate() {
  return createEvalCandidate(validCandidateInput())
}

function validCandidateInput() {
  return {
    schemaVersion: 1 as const,
    id: 'candidate-1',
    source: {
      traceIdHash: 'a'.repeat(64),
      signal: 'verification_failure' as const,
    },
    fixture: {
      kind: 'synthetic' as const,
      contentSha256: 'c'.repeat(64),
      containsUserCode: false,
      license: 'MIT',
      isolation: 'container' as const,
    },
    privacy: {
      status: 'approved' as const,
      detectorVersion: 'privacy-v1',
      findingCount: 0,
    },
    reproduction: {
      status: 'passed' as const,
      runs: 3,
      successes: 3,
      environmentDigest: 'd'.repeat(64),
      graderDigest: 'e'.repeat(64),
    },
    humanReview: {
      required: true,
      status: 'approved' as const,
      reviewId: 'review-1',
    },
    evalCase: {
      schemaVersion: 1 as const,
      id: 'case-1',
      suite: 'regression' as const,
      tags: ['trace-candidate'],
      metadata: { source: 'trace-candidate', license: 'MIT' },
      task: {
        prompt: '在合成项目中修复版本字段',
        taskSpec: {
          id: 'task-1',
          goal: '修复版本字段',
          allowedPaths: ['package.json'],
          verificationCommands: [],
        },
      },
      fixture: { path: 'fixtures/case-1' },
      limits: { timeoutMs: 60_000, maxTurns: 4, maxToolCalls: 8 },
      submission: { type: 'files' as const, allowedPaths: ['package.json'] },
      verification: {
        graders: [{ type: 'changed-paths', allowedPaths: ['package.json'] }],
      },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}
