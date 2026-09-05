'use client'

export type MiniStackCounts = { pass: number; fail: number; unknown: number; pending: number }

/** 迷你 P/F/U/M 堆叠条：列表与卡片里的结果构成速览。 */
export function MiniStack({ counts }: { counts: MiniStackCounts }) {
  const total = counts.pass + counts.fail + counts.unknown + counts.pending
  if (total === 0) {
    return null
  }
  const width = (value: number) => `${(value / total) * 100}%`
  return (
    <div className="bench-mini-stack" aria-hidden="true">
      <span className="mini-pass" style={{ width: width(counts.pass) }} />
      <span className="mini-fail" style={{ width: width(counts.fail) }} />
      <span className="mini-unknown" style={{ width: width(counts.unknown) }} />
    </div>
  )
}

/** 从 Job 摘要推导 P/F/U/M 四段计数；未执行的部分单列，不冒充失败。 */
export function jobStackCounts(job: {
  total: number
  completed: number
  summary?: { totalCases?: number; passedCases?: number; failedCases?: number } | null
}): MiniStackCounts {
  const pass = job.summary?.passedCases ?? 0
  const fail = job.summary?.failedCases ?? 0
  const executed = job.summary?.totalCases ?? job.completed
  const unknown = Math.max(0, executed - pass - fail)
  return { pass, fail, unknown, pending: Math.max(0, job.total - executed) }
}
