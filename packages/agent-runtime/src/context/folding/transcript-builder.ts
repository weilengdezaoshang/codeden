import { createHash } from 'node:crypto'
import type { SecretRedactor } from '@codeden/core/security/secret-redactor.js'
import type { ModelMessage } from '../../models/model-types.js'

/** 冻结区间的最小结构输入：SessionTurn 与任意等构事件源均可直接传入。 */
export interface TranscriptTurnInput {
  turnId?: string
  prompt: string
  status: string
  stopReason?: string
  finalResponse: string
  turnTranscript?: ModelMessage[]
}

/** 冻结区间内的脱敏轮次：prompt、模型正文与工具调用参数均已过 redactor。 */
export interface SanitizedTurn {
  sequence: number
  turnId?: string
  prompt: string
  status: string
  stopReason?: string
  messages: ModelMessage[]
  /** assistant.toolCalls 中已匹配到 tool 结果的调用 ID 集合。 */
  resolvedToolCallIds: Set<string>
}

export interface FrozenTranscript {
  turns: SanitizedTurn[]
  /** 冻结内容（脱敏后）的 sha256，写入 FoldedSessionMemory.sourceDigest。 */
  digest: string
  /** 区间内失败的模型轮次（agent_error/timeout/interrupted）。 */
  failedTurnIds: string[]
  /** 区间内未匹配 tool 结果的未完成调用（EX-13：不得摘要为成功）。 */
  unresolvedToolCalls: Array<{ turnId?: string; callId: string; toolName: string }>
}

/**
 * TranscriptBuilder —— 主计划 9.20 第二步：冻结 source event range 并构造无 Secret transcript。
 * 复用 SecretRedactor 对所有进入折叠的内容脱敏；digest 基于脱敏后的规范序列化，
 * 保证同一区间重复冻结得到相同指纹。
 */
export function buildTranscript(
  turns: readonly TranscriptTurnInput[],
  redactor?: SecretRedactor,
): FrozenTranscript {
  const sanitized = turns.map((turn, index) => sanitizeTurn(turn, index, redactor))
  const digest = createHash('sha256')
    .update(stableSerialize(sanitized.map(serializeableTurn)))
    .digest('hex')
  return {
    turns: sanitized,
    digest,
    failedTurnIds: sanitized
      .filter(
        (turn) =>
          turn.status === 'agent_error' ||
          turn.status === 'timeout' ||
          turn.stopReason === 'interrupted',
      )
      .map((turn) => turn.turnId ?? `turn-${turn.sequence}`),
    unresolvedToolCalls: collectUnresolvedToolCalls(sanitized),
  }
}

function sanitizeTurn(
  turn: TranscriptTurnInput,
  index: number,
  redactor?: SecretRedactor,
): SanitizedTurn {
  const redact = (value: string): string => redactor?.redact(value) ?? value
  const messages = transcriptMessages(turn).map((message) => ({
    ...message,
    content: redact(message.content),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            arguments: redact(safeSerialize(call.arguments)),
          })),
        }
      : {}),
  }))
  return {
    sequence: index + 1,
    ...(turn.turnId ? { turnId: turn.turnId } : {}),
    prompt: redact(turn.prompt),
    status: turn.status,
    ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
    messages,
    resolvedToolCallIds: collectResolvedToolCallIds(turn),
  }
}

function transcriptMessages(turn: TranscriptTurnInput): ModelMessage[] {
  if (turn.turnTranscript && turn.turnTranscript.length > 0) {
    return [...turn.turnTranscript]
  }
  return [{ role: 'assistant', content: turn.finalResponse }]
}

function collectResolvedToolCallIds(turn: TranscriptTurnInput): Set<string> {
  const resolved = new Set<string>()
  for (const message of turn.turnTranscript ?? []) {
    if (message.role === 'tool' && message.toolCallId) {
      resolved.add(message.toolCallId)
    }
  }
  return resolved
}

function collectUnresolvedToolCalls(
  turns: readonly SanitizedTurn[],
): FrozenTranscript['unresolvedToolCalls'] {
  const unresolved: FrozenTranscript['unresolvedToolCalls'] = []
  for (const turn of turns) {
    for (const message of turn.messages) {
      for (const call of message.toolCalls ?? []) {
        if (!turn.resolvedToolCallIds.has(call.id)) {
          unresolved.push({
            ...(turn.turnId ? { turnId: turn.turnId } : {}),
            callId: call.id,
            toolName: call.name,
          })
        }
      }
    }
  }
  return unresolved
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value ?? '')
  } catch {
    return String(value)
  }
}

function serializeableTurn(turn: SanitizedTurn): Record<string, unknown> {
  return {
    sequence: turn.sequence,
    turnId: turn.turnId,
    prompt: turn.prompt,
    status: turn.status,
    stopReason: turn.stopReason,
    messages: turn.messages,
    resolved: [...turn.resolvedToolCallIds].sort(),
  }
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : nested,
  )
}
