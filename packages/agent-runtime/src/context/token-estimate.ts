/**
 * 上下文预算的字符级 token 估算。
 *
 * 不引入 tokenizer：按固定系数把字符数换算为 token 数，系数默认对齐英文文本
 * 的 4 字符 ≈ 1 token，可由配置按模型族校准。结果恒为估算值（estimated: true），
 * 与 provider 返回的真实 usage 区分。
 */
export const DEFAULT_ESTIMATE_COEFFICIENT = 4

export interface TokenEstimate {
  tokens: number
  estimated: true
}

export function estimateTokens(
  text: string,
  coefficient: number = DEFAULT_ESTIMATE_COEFFICIENT,
): TokenEstimate {
  const safeCoefficient =
    Number.isFinite(coefficient) && coefficient > 0 ? coefficient : DEFAULT_ESTIMATE_COEFFICIENT
  return { tokens: Math.ceil(text.length / safeCoefficient), estimated: true }
}
