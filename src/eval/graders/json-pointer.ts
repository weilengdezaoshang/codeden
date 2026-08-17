export function getJsonPointer(
  document: unknown,
  pointer: string,
): { found: boolean; value?: unknown } {
  if (pointer === '') {
    return { found: true, value: document }
  }
  if (!pointer.startsWith('/')) {
    return { found: false }
  }

  const parts = pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))

  let current: unknown = document
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return { found: false }
    }
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false }
      }
      current = current[index]
      continue
    }
    if (!(part in current)) {
      return { found: false }
    }
    current = (current as Record<string, unknown>)[part]
  }

  return { found: true, value: current }
}
