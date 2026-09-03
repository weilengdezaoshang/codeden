import { contentDigest } from '@codeden/core/content-digest.js'
import type { RunEvidence } from '../domain/eval-run.js'

/** 摘要只依赖样本身份与内容，不依赖执行顺序或分批方式。 */
export function evidenceCaseDigests(cases: RunEvidence['cases']) {
  const sorted = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (new Set(sorted.map((entry) => entry.id)).size !== sorted.length) {
    throw new Error('证据样本编号重复')
  }
  if (sorted.some((entry) => !entry.graderDigest)) {
    throw new Error('旧证据缺少逐样本评分器摘要，请重新运行评测')
  }
  return {
    datasetDigest: contentDigest(sorted.map(({ id, suite, digest }) => ({ id, suite, digest }))),
    graderDigest: contentDigest(sorted.map(({ id, graderDigest }) => ({ id, graderDigest }))),
  }
}
