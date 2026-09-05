import type { EvalCase } from '@codeden/eval-engine/domain/eval-case.js'

/** 重复展开：轮次优先交错（c1, c2, c1#2, c2#2…），第 1 次不带后缀。 */
export function repeatCases(cases: EvalCase[], repetitions: number) {
  return Array.from({ length: repetitions }, (_, repetition) =>
    cases.map((item) => ({
      ...item,
      id: repetitions === 1 ? item.id : `${item.id}#${repetition + 1}`,
    })),
  ).flat()
}
