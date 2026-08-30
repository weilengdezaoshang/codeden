import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentDigest } from '../core/content-digest.js'
import type { EvalCase } from '../eval/domain/eval-case.js'
import { RunEvidenceSchema } from '../eval/domain/eval-run.js'
import { digestCandidateFixture } from '../eval/candidates/signed-candidate-evidence-verifier.js'
import type { ModelProvider } from '../runtime/models/model-provider.js'
import { evidenceCaseDigests } from './evidence-case-digests.js'

/** 仅为显式开启发布证据的 Native 评测生成清单，失败时不生成可晋级的证据。 */
export async function createRunEvidence(cases: readonly EvalCase[], model: ModelProvider) {
  const codeRoot = fileURLToPath(new URL('../', import.meta.url))
  const packageRoot = path.resolve(codeRoot, '..')
  const runtimeDigest = await digestCandidateFixture(codeRoot, 'runtime')
  const graderDigest = await digestCandidateFixture(codeRoot, 'eval/graders')
  const coreDigest = await digestCandidateFixture(codeRoot, 'core')
  const lock = await readFile(path.join(packageRoot, 'pnpm-lock.yaml'), 'utf8')
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
      lock,
    }),
    cases: entries,
  })
}
