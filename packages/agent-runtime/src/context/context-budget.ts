import type { ModelMessage, ModelProfile } from '../models/model-types.js'
import { DEFAULT_ESTIMATE_COEFFICIENT } from './token-estimate.js'

/**
 * 上下文预算策略：决定"什么时候需要压缩"的参数。
 * M0 仅观测（随 context.utilization 事件上报），阈值触发折叠在 M2 接线。
 */
export interface ContextBudgetPolicy {
  /** utilization 达到该值即视为逼近窗口；默认 0.70，为回复与下轮工具结果留余量。 */
  utilizationThreshold: number
  /** 字符/token 估算系数；默认 4，可按模型族校准。 */
  estimateCoefficient: number
  /** 为模型输出预留的 token 数，计入占用。 */
  reserveOutputTokens: number
  /**
   * 工具结果入历史的字符预算：超出即 head+tail 裁剪（M1/EX-7）。
   * 默认对齐现有单工具最大自律值（1,000,000 字符），正常工具不触发；
   * 设为 Infinity 等价关闭。
   */
  toolResultBudgetChars: number
}

export const DEFAULT_CONTEXT_BUDGET_POLICY: ContextBudgetPolicy = {
  utilizationThreshold: 0.7,
  estimateCoefficient: DEFAULT_ESTIMATE_COEFFICIENT,
  reserveOutputTokens: 8_192,
  toolResultBudgetChars: 1_000_000,
}

/** 单条工具结果消息的字符预算上限；`Infinity` 或非正数表示不裁剪。 */
export const MAX_TOOL_RESULT_CHARS = DEFAULT_CONTEXT_BUDGET_POLICY.toolResultBudgetChars

/**
 * 工具结果入历史统一裁剪：超出预算保留 head+tail（不劈开代理对/emoji），
 * 注入 `[truncated: 原始 N 字符，已截断]` 标记。trace/事件保留未裁剪原文。
 */
export function trimToBudget(content: string, budgetChars: number): string {
  const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? Math.floor(budgetChars) : 0
  const chars = Array.from(content)
  if (budget <= 0 || chars.length <= budget) {
    return content
  }
  const marker = `[truncated: 原始 ${chars.length} 字符，已截断]`
  const headCount = Math.max(1, Math.floor((budget - marker.length) / 2))
  const tailCount = Math.min(chars.length - headCount, headCount)
  if (tailCount <= 0) {
    return `${chars.slice(0, headCount).join('')}\n${marker}`
  }
  const head = chars.slice(0, headCount).join('')
  const tail = chars.slice(chars.length - tailCount).join('')
  return `${head}\n${marker}\n${tail}`
}

/** 未知模型的保守窗口：宁可提前触发压缩，也不发出超出窗口的请求。 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 32_000
export const FALLBACK_MAX_OUTPUT_TOKENS = 8_192

export interface ResolvedModelProfile {
  contextWindowTokens: number
  maxOutputTokens: number
  supportsPromptCaching: boolean
  /** true 表示窗口来自保守默认而非模型档案，占用估算仅作参考。 */
  estimated: boolean
}

/** 补齐档案缺省字段；未登记模型回退为保守默认并置 estimated。 */
export function resolveModelProfile(profile?: ModelProfile): ResolvedModelProfile {
  return {
    contextWindowTokens: profile?.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: profile?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS,
    supportsPromptCaching: profile?.supportsPromptCaching ?? false,
    estimated: profile?.contextWindowTokens === undefined,
  }
}

export interface ContextUtilization {
  /** (估算输入 + 输出预留) / 窗口；可能大于 1，表示按估算已超出窗口。 */
  ratio: number
  estimatedInputTokens: number
  contextWindowTokens: number
  reserveOutputTokens: number
  threshold: number
  estimated: true
}

/**
 * 计算消息序列对模型窗口的估算占用。
 * 字符统计覆盖消息正文与工具调用参数（arguments 序列化后的长度）。
 */
export function computeUtilization(
  messages: readonly ModelMessage[],
  profile: ModelProfile | ResolvedModelProfile,
  policy: ContextBudgetPolicy = DEFAULT_CONTEXT_BUDGET_POLICY,
): ContextUtilization {
  const resolved = resolveModelProfile(profile)
  const coefficient =
    Number.isFinite(policy.estimateCoefficient) && policy.estimateCoefficient > 0
      ? policy.estimateCoefficient
      : DEFAULT_ESTIMATE_COEFFICIENT
  let characters = 0
  for (const message of messages) {
    characters += message.content.length
    for (const call of message.toolCalls ?? []) {
      characters += call.name.length
      characters += serializeLength(call.arguments)
    }
  }
  const estimatedInputTokens = Math.ceil(characters / coefficient)
  const ratio =
    (estimatedInputTokens + policy.reserveOutputTokens) / Math.max(1, resolved.contextWindowTokens)
  return {
    ratio,
    estimatedInputTokens,
    contextWindowTokens: resolved.contextWindowTokens,
    reserveOutputTokens: policy.reserveOutputTokens,
    threshold: policy.utilizationThreshold,
    estimated: true,
  }
}

function serializeLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? '').length
  } catch {
    return 0
  }
}
