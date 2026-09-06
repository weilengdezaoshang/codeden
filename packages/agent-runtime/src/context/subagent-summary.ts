import type { AgentRunResult } from '../agent/agent-contracts.js'

export type SubagentSummaryMode = 'full' | 'summary'

/** 父上下文收到的子任务摘要预算（M3/EX-14）；完整轨迹仅保留在 session/trace。 */
export const SUBAGENT_SUMMARY_BUDGET_CHARS = 2_000

export interface SubagentSummaryOutput {
  summary: string
  /** true = 结论超出预算被强制截断（信息不完整），父任务不得视为完整结论。 */
  degraded: boolean
  status: AgentRunResult['status']
  stopReason?: string
  turnCount: number
  toolCalls: number
  toolFailures: number
}

const STATUS_LABELS: Record<AgentRunResult['status'], string> = {
  verified_complete: '已完成（通过验证）',
  submitted: '已完成（未验证）',
  timeout: '未完成（超时或被取消）',
  budget_exhausted: '未完成（预算耗尽）',
  agent_error: '未完成（执行出错）',
}

/**
 * 确定性结构化摘要：状态、元信息（轮数/调用/失败/终止原因）与结论。
 * 未完成任务显式标注，禁止摘要为成功；结论超预算时强制截断并置 degraded。
 */
export function buildSubagentSummary(
  result: AgentRunResult,
  budgetChars = SUBAGENT_SUMMARY_BUDGET_CHARS,
): SubagentSummaryOutput {
  const completed = result.status === 'verified_complete' || result.status === 'submitted'
  const metaParts = [
    `轮数 ${result.metrics.turns ?? 0}`,
    `工具调用 ${result.metrics.toolCalls ?? 0}（失败 ${result.metrics.toolFailures ?? 0}）`,
    result.stopReason ? `终止原因 ${result.stopReason}` : undefined,
  ].filter((part): part is string => Boolean(part))
  const lines = [
    `[子任务] ${STATUS_LABELS[result.status] ?? result.status}`,
    `[元信息] ${metaParts.join(' · ')}`,
  ]
  const submission = result.submission
  if (submission?.type === 'files' && submission.changedPaths.length > 0) {
    const listed = submission.changedPaths.slice(0, 10).join(', ')
    const suffix =
      submission.changedPaths.length > 10 ? ` 等 ${submission.changedPaths.length} 个` : ''
    lines.push(`[涉及文件] ${listed}${suffix}`)
  }

  const used = Array.from(lines.join('\n')).length
  const available = Math.max(0, budgetChars - used - '[结论] '.length - 2)
  const conclusionChars = Array.from(result.finalResponse ?? '')
  const clipped = conclusionChars.length > available
  const conclusion = conclusionChars.slice(0, available).join('').trim()
  if (conclusion) {
    lines.push(`[结论] ${conclusion}${clipped ? '…' : ''}`)
  } else if (!completed) {
    lines.push('[结论] （无最终回复）')
  }

  return {
    summary: lines.join('\n'),
    degraded: clipped,
    status: result.status,
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    turnCount: result.metrics.turns ?? 0,
    toolCalls: result.metrics.toolCalls ?? 0,
    toolFailures: result.metrics.toolFailures ?? 0,
  }
}
