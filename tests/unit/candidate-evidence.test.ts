import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runEvalGateCommand } from '../../apps/eval-platform/src/cli/eval-gate-command.js'
import { contentDigest } from '../../packages/core/src/content-digest.js'
import { createEvalCandidate } from '../../packages/eval-engine/src/candidates/eval-candidate.js'
import { CandidateDatasetStore } from '../../packages/eval-engine/src/candidates/candidate-dataset-store.js'
import {
  digestCandidateFixture,
  SignedCandidateEvidenceVerifier,
} from '../../packages/eval-engine/src/candidates/signed-candidate-evidence-verifier.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'codeden-receipt-'))
  roots.push(root)
  await mkdir(path.join(root, 'fixture'))
  await writeFile(path.join(root, 'fixture', 'sample.txt'), 'synthetic')
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const candidate = createEvalCandidate({
    schemaVersion: 1,
    id: 'candidate',
    source: { traceIdHash: 'a'.repeat(64), signal: 'sampled_success' },
    fixture: {
      kind: 'synthetic',
      contentSha256: await digestCandidateFixture(root, 'fixture'),
      containsUserCode: false,
      license: 'MIT',
      isolation: 'container',
    },
    privacy: { status: 'approved', detectorVersion: 'v1', findingCount: 0 },
    reproduction: {
      status: 'passed',
      runs: 2,
      successes: 2,
      environmentDigest: 'b'.repeat(64),
      graderDigest: 'c'.repeat(64),
    },
    humanReview: { required: true, status: 'approved', reviewId: 'review-1' },
    evalCase: {
      schemaVersion: 1,
      id: 'case',
      suite: 'regression',
      task: { prompt: '回答', taskSpec: { id: 'task', goal: '回答' } },
      fixture: { path: 'fixture' },
      limits: { timeoutMs: 1000, maxTurns: 1, maxToolCalls: 1 },
      submission: { type: 'text' },
      verification: {
        graders: [
          { type: 'persona-rubric', criteria: [{ id: 'short', kind: 'max_chars', value: 30 }] },
        ],
      },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  const candidateDigest = contentDigest(candidate)
  const receipt = {
    schemaVersion: 1,
    candidateDigest,
    signature: sign(null, Buffer.from(candidateDigest), keys.privateKey).toString('base64'),
  }
  const verifier = new SignedCandidateEvidenceVerifier(root, publicKey)
  return { root, candidate, receipt, verifier, publicKey }
}

describe('测试套件：候选审核凭证真实性', () => {
  it('命令行晋级入口使用真实签名校验并写入候选集', async () => {
    const { root, candidate, receipt, publicKey } = await setup()
    await writeFile(path.join(root, 'candidate.json'), JSON.stringify(candidate))
    await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt))
    await writeFile(path.join(root, 'reviewer.pem'), publicKey)
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const args = [
      'candidate-promote',
      '--candidate',
      path.join(root, 'candidate.json'),
      '--receipt',
      path.join(root, 'receipt.json'),
      '--trusted-key',
      path.join(root, 'reviewer.pem'),
    ]
    expect(await runEvalGateCommand(args)).toBe(0)
    expect(await runEvalGateCommand(args)).toBe(1)
  })
  it('完整签名凭证入库后再次加载仍校验签名与 fixture', async () => {
    const { root, candidate, receipt, verifier } = await setup()
    const store = new CandidateDatasetStore(root, verifier)
    expect((await store.promote(candidate, receipt)).status).toBe('accepted')
    expect(await store.listCases()).toHaveLength(1)
    await writeFile(path.join(root, 'fixture', 'sample.txt'), 'changed')
    await expect(store.listCases()).rejects.toThrow('Invalid candidate dataset record')
  })

  it('修改隐私结论、人格或使用其他签名密钥不能复用原审核凭证', async () => {
    const { candidate, receipt, verifier } = await setup()
    expect(
      (
        await verifier.verify(
          { ...candidate, privacy: { ...candidate.privacy, detectorVersion: 'forged' } },
          receipt,
        )
      ).passed,
    ).toBe(false)
    expect(
      (
        await verifier.verify(
          {
            ...candidate,
            evalCase: {
              ...candidate.evalCase,
              persona: { instruction: '另一人格', source: 'eval-case' },
            },
          },
          receipt,
        )
      ).passed,
    ).toBe(false)
    const otherKey = generateKeyPairSync('ed25519').privateKey
    expect(
      (
        await verifier.verify(candidate, {
          ...receipt,
          signature: sign(null, Buffer.from(receipt.candidateDigest), otherKey).toString('base64'),
        })
      ).passed,
    ).toBe(false)
  })

  it('fixture 目录包含符号链接时拒绝散列与晋级', async () => {
    const { root, candidate, receipt, verifier } = await setup()
    await symlink('sample.txt', path.join(root, 'fixture', 'link'))
    await expect(digestCandidateFixture(root, 'fixture')).rejects.toThrow()
    expect((await verifier.verify(candidate, receipt)).passed).toBe(false)
  })

  it('多个 Store 并发晋级同一候选最多写入一次', async () => {
    const { root, candidate, receipt, verifier } = await setup()
    const stores = [
      new CandidateDatasetStore(root, verifier),
      new CandidateDatasetStore(root, verifier),
    ]
    const results = await Promise.allSettled(
      stores.map((store) => store.promote(candidate, receipt)),
    )
    expect(
      results.filter(
        (result) => result.status === 'fulfilled' && result.value.status === 'accepted',
      ),
    ).toHaveLength(1)
    expect(await stores[0]!.listCases()).toHaveLength(1)
  })
})
