import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { coreArtifactRoot } from '@codeden/core/artifact-root.js'
import { runtimeArtifactRoot } from '@codeden/agent-runtime/artifact-root.js'
import { contentDigest } from '@codeden/core/content-digest.js'
import type { EvalCase } from '../domain/eval-case.js'
import { RunEvidenceSchema } from '../domain/eval-run.js'
import { digestCandidateFixture } from '../candidates/signed-candidate-evidence-verifier.js'
import type { ModelProvider } from '@codeden/agent-runtime/models/model-provider.js'
import { evidenceCaseDigests } from './evidence-case-digests.js'

/** 仅为显式开启发布证据的 Native 评测生成清单，失败时不生成可晋级的证据。 */
export async function createRunEvidence(cases: readonly EvalCase[], model: ModelProvider) {
  const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const runtimeDigest = await digestDirectory(path.dirname(fileURLToPath(runtimeArtifactRoot)))
  const graderDigest = await digestCandidateFixture(codeRoot, 'graders')
  const coreDigest = await digestDirectory(path.dirname(fileURLToPath(coreArtifactRoot)))
  const lockDigest = await readLockDigest(codeRoot)
  const manifests = await Promise.all(
    cases.map(async (item) => {
      if (item.fixture.repository) {
        throw new Error('发布证据暂仅支持本地独立 fixture')
      }
      const fixture = path.resolve(item.fixture.path)
      const fixtureDigest = await digestCandidateFixture(
        path.dirname(fixture),
        path.basename(fixture),
      )
      return { ...item, fixture: { contentSha256: fixtureDigest } }
    }),
  )
  const entries = manifests.map((item) => {
    if (item.suite === 'training') {
      throw new Error('训练样本不能用作发布证据')
    }
    return {
      id: item.id,
      suite: item.suite,
      digest: contentDigest(item),
      graderDigest: contentDigest({ graderDigest, config: item.verification }),
    }
  })
  return RunEvidenceSchema.parse({
    agentDigest: contentDigest({
      name: model.name,
      descriptor: model.descriptor,
      runtimeDigest,
      coreDigest,
      userInstructions: 'fixture-only',
    }),
    ...evidenceCaseDigests(entries),
    environmentDigest: contentDigest({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      lockDigest,
    }),
    cases: entries,
  })
}

function digestDirectory(directory: string) {
  const resolved = path.resolve(directory)
  return digestCandidateFixture(path.dirname(resolved), path.basename(resolved))
}

async function readLockDigest(codeRoot: string): Promise<string> {
  if (path.basename(codeRoot) === 'src') {
    return createHash('sha256')
      .update(await readFile(path.resolve(codeRoot, '../../../pnpm-lock.yaml')))
      .digest('hex')
  }
  const value = JSON.parse(
    await readFile(path.join(codeRoot, 'build-provenance.json'), 'utf8'),
  ) as {
    schemaVersion?: unknown
    lockDigest?: unknown
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.lockDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.lockDigest)
  ) {
    throw new Error('构建产物缺少可信的依赖锁指纹，请重新执行 pnpm build')
  }
  return value.lockDigest
}
