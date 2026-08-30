/** 仅供应商明确返回非负整数时视为计量，缺失值不能作为零消耗参与门禁。 */
export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function measuredUsage(input: unknown, output: unknown) {
  return {
    inputTokens: isTokenCount(input) ? input : 0,
    outputTokens: isTokenCount(output) ? output : 0,
    ...(!(isTokenCount(input) && isTokenCount(output)) ? { status: 'unavailable' as const } : {}),
  }
}
