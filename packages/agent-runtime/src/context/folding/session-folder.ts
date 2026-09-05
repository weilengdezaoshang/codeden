import type { SecretRedactor } from '@codeden/core/security/secret-redactor.js'
import type { ModelMessage } from '../../models/model-types.js'
import {
  FoldedSessionMemorySchema,
  type FoldProjection,
  type FoldTrigger,
  type FoldedSessionMemory,
  type KeyEvent,
  type NextAction,
} from './folded-memory.js'
import { buildTranscript, type FrozenTranscript, type SanitizedTurn } from './transcript-builder.js'

/** 未完成 tool call 在挑战列表中的固定标记（EX-13：不得摘要为成功）。 */
export const UNRESOLVED_TOOL_CALL_MARKER = '未完成 tool call'

export interface SessionFoldInput {
  sessionId: string
  trigger: FoldTrigger
  /** 冻结并折叠的轮次区间（原文不删除，仅生成派生投影）。 */
  turns: readonly SessionTurnInput[]
  /** 折叠区间在会话事件流中的轮次编号（写入 sourceSequenceRange）。 */
  sourceSequenceRange: { from: number; to: number }
  redactor?: SecretRedactor
  now?: () => Date
}

/** 与 SessionTurn 的结构解耦，便于对任意事件源（含历史快照）做确定性折叠。 */
export interface SessionTurnInput {
  turnId?: string
  prompt: string
  status: string
  stopReason?: string
  finalResponse: string
  turnTranscript?: ModelMessage[]
}

export interface FoldValidation {
  ok: boolean
  missing: string[]
}

export interface SessionFoldResult {
  projection: FoldProjection
  memory: FoldedSessionMemory
  transcript: FrozenTranscript
  validation: FoldValidation
}

/**
 * SessionFolder —— 主计划 9.20 确定性折叠：从冻结 transcript 确定性抽取三层记忆。
 * M2a 只交付确定性路径，产出一律 degraded=true；LLM 摘要增强在 M2b 接入。
 */
export class SessionFolder {
  fold(input: SessionFoldInput): SessionFoldResult {
    if (input.turns.length === 0) {
      throw new Error('折叠区间为空，拒绝折叠')
    }
    const createdAt = (input.now ?? ((): Date => new Date()))().toISOString()
    const transcript = buildTranscript(input.turns, input.redactor)
    const memory = extractMemory(input, transcript, createdAt)
    const validation = validateFold(memory, {
      firstPrompt: input.turns[0]?.prompt ?? '',
      lastPrompt: input.turns.at(-1)?.prompt ?? '',
      failedToolResultCount: countFailedToolResults(transcript.turns),
      unresolvedToolCallCount: transcript.unresolvedToolCalls.length,
    })
    if (!validation.ok) {
      throw new Error(`折叠校验未通过，拒绝切换：${validation.missing.join('；')}`)
    }
    const projection: FoldProjection = {
      schemaVersion: 1,
      createdAt,
      degraded: true,
      memory,
    }
    return { projection, memory, transcript, validation }
  }
}

function extractMemory(
  input: SessionFoldInput,
  transcript: FrozenTranscript,
  createdAt: string,
): FoldedSessionMemory {
  const turns = transcript.turns
  const firstPrompt = turns[0]?.prompt ?? ''
  const lastPrompt = turns.at(-1)?.prompt ?? ''
  const toolStats = aggregateToolUsage(turns)
  const keyEvents = collectKeyEvents(turns)
  const challenges = collectChallenges(transcript, toolStats)
  const nextActions = collectNextActions(transcript)
  const okTurns = turns.filter(
    (turn) => turn.status === 'verified_complete' || turn.status === 'submitted',
  ).length
  const failedTurns = transcript.failedTurnIds.length
  const totalCalls = [...toolStats.values()].reduce((sum, stat) => sum + stat.calls, 0)
  const failedCalls = [...toolStats.values()].reduce((sum, stat) => sum + stat.failures, 0)

  return FoldedSessionMemorySchema.parse({
    schemaVersion: 1,
    sessionId: input.sessionId,
    createdAt,
    trigger: input.trigger,
    sourceSequenceRange: input.sourceSequenceRange,
    episodeMemory: {
      taskDescription: firstPrompt,
      keyEvents,
      currentProgress: `已折叠 ${turns.length} 轮（成功 ${okTurns}，失败 ${failedTurns}）；工具调用 ${totalCalls} 次，失败 ${failedCalls} 次。`,
    },
    workingMemory: {
      immediateGoal: lastPrompt,
      currentChallenges: challenges,
      nextActions,
    },
    toolMemory: {
      toolsUsed: [...toolStats.entries()].map(([tool, stat]) => ({
        tool,
        calls: stat.calls,
        failures: stat.failures,
        ...(stat.lastFailureMessage ? { note: stat.lastFailureMessage } : {}),
      })),
      derivedRules: collectDerivedRules(toolStats),
    },
    sourceDigest: transcript.digest,
  })
}

function collectKeyEvents(turns: readonly SanitizedTurn[]): KeyEvent[] {
  const events: KeyEvent[] = []
  for (const turn of turns) {
    for (const message of turn.messages) {
      for (const call of message.toolCalls ?? []) {
        events.push({
          ...(turn.turnId ? { turnId: turn.turnId } : {}),
          kind: 'tool',
          description: `调用工具 ${call.name}`,
        })
      }
    }
    if (turn.status === 'verified_complete') {
      events.push({
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
        kind: 'milestone',
        description: `轮次通过完成验证：${clip(turn.prompt)}`,
      })
    }
    if (turn.status === 'agent_error' || turn.status === 'timeout') {
      events.push({
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
        kind: 'obstacle',
        description: `轮次以 ${turn.status} 结束：${clip(turn.prompt)}`,
      })
    }
  }
  return events
}

interface ToolStat {
  calls: number
  failures: number
  lastFailureMessage?: string
}

function aggregateToolUsage(turns: readonly SanitizedTurn[]): Map<string, ToolStat> {
  const stats = new Map<string, ToolStat>()
  const statFor = (tool: string): ToolStat => {
    const existing = stats.get(tool)
    if (existing) {
      return existing
    }
    const created: ToolStat = { calls: 0, failures: 0 }
    stats.set(tool, created)
    return created
  }
  for (const turn of turns) {
    const callNames = new Map<string, string>()
    for (const message of turn.messages) {
      for (const call of message.toolCalls ?? []) {
        callNames.set(call.id, call.name)
        statFor(call.name).calls += 1
      }
      if (message.role === 'tool' && message.toolCallId) {
        const name = callNames.get(message.toolCallId)
        if (name && isToolFailure(message.content)) {
          const stat = statFor(name)
          stat.failures += 1
          stat.lastFailureMessage = failureMessage(message.content)
        }
      }
    }
  }
  return stats
}

function collectChallenges(
  transcript: FrozenTranscript,
  toolStats: Map<string, ToolStat>,
): string[] {
  const challenges: string[] = []
  for (const call of transcript.unresolvedToolCalls) {
    challenges.push(`${UNRESOLVED_TOOL_CALL_MARKER} ${call.toolName}(${call.callId})，结果未知`)
  }
  for (const turn of transcript.turns) {
    if (
      turn.status === 'agent_error' ||
      turn.status === 'timeout' ||
      turn.stopReason === 'interrupted'
    ) {
      challenges.push(`轮次未正常完成（${turn.status}）：${clip(turn.prompt)}`)
    }
  }
  for (const [tool, stat] of toolStats) {
    if (stat.failures > 0) {
      challenges.push(
        `工具 ${tool} 失败 ${stat.failures} 次${stat.lastFailureMessage ? `（最后失败：${stat.lastFailureMessage}）` : ''}`,
      )
    }
  }
  return challenges
}

function collectNextActions(transcript: FrozenTranscript): NextAction[] {
  const actions: NextAction[] = []
  for (const call of transcript.unresolvedToolCalls) {
    actions.push({
      description: `确认${UNRESOLVED_TOOL_CALL_MARKER}的实际结果：${call.toolName}`,
      relatedTool: call.toolName,
    })
  }
  for (const turn of transcript.turns) {
    if (
      turn.status === 'agent_error' ||
      turn.status === 'timeout' ||
      turn.stopReason === 'interrupted'
    ) {
      actions.push({ description: `继续处理未完成轮次：${clip(turn.prompt)}` })
    }
  }
  return actions
}

function collectDerivedRules(toolStats: Map<string, ToolStat>): string[] {
  const rules: string[] = []
  for (const [tool, stat] of toolStats) {
    if (stat.failures >= 2) {
      rules.push(
        `工具 ${tool} 在折叠区间内失败 ${stat.failures} 次${stat.lastFailureMessage ? `（最后失败：${stat.lastFailureMessage}）` : ''}，重试前先检查参数与前置条件。`,
      )
    }
  }
  return rules
}

/**
 * FoldValidator —— 主计划 9.20 第五步：检查关键路径/命令/约束/未完成 Tool Call 是否保留。
 * 任一必留项缺失即拒绝切换，调用方继续使用旧 Model History。
 */
export function validateFold(
  memory: FoldedSessionMemory,
  source: {
    firstPrompt: string
    lastPrompt: string
    failedToolResultCount: number
    unresolvedToolCallCount: number
  },
): FoldValidation {
  const missing: string[] = []
  if (memory.episodeMemory.taskDescription.trim() !== source.firstPrompt.trim()) {
    missing.push('任务描述未保留首条 prompt')
  }
  if (memory.workingMemory.immediateGoal.trim() !== source.lastPrompt.trim()) {
    missing.push('当前目标未保留最后一条 prompt')
  }
  const recordedFailures = memory.toolMemory.toolsUsed.reduce((sum, item) => sum + item.failures, 0)
  if (recordedFailures < source.failedToolResultCount) {
    missing.push(
      `失败证据不完整：源区间 ${source.failedToolResultCount} 次工具失败，仅记录 ${recordedFailures} 次`,
    )
  }
  if (
    source.unresolvedToolCallCount > 0 &&
    !memory.workingMemory.currentChallenges.some((item) =>
      item.includes(UNRESOLVED_TOOL_CALL_MARKER),
    )
  ) {
    missing.push('未完成 tool call 未按 unknown 保留（EX-13）')
  }
  return missing.length === 0 ? { ok: true, missing } : { ok: false, missing }
}

function countFailedToolResults(turns: readonly SanitizedTurn[]): number {
  let count = 0
  for (const turn of turns) {
    for (const message of turn.messages) {
      if (message.role === 'tool' && isToolFailure(message.content)) {
        count += 1
      }
    }
  }
  return count
}

/** 工具失败结果的确定性判别：executor 写入的 error 对象带 code/category/message。 */
function isToolFailure(content: string): boolean {
  if (!content.startsWith('{')) {
    return false
  }
  try {
    const value: unknown = JSON.parse(content)
    return (
      typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      'category' in value &&
      'message' in value
    )
  } catch {
    return false
  }
}

function failureMessage(content: string): string {
  try {
    const value: unknown = JSON.parse(content)
    if (typeof value === 'object' && value !== null && 'message' in value) {
      return clip(String((value as { message: unknown }).message))
    }
  } catch {
    // 无法解析时留空 note。
  }
  return ''
}

function clip(value: string, limit = 120): string {
  const trimmed = value.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}
