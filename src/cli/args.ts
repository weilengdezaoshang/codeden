export function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) {
    return undefined
  }
  return argv[index + 1]
}

export function readNumberFlag(argv: string[], name: string, fallback: number): number {
  const raw = readFlag(argv, name)
  if (raw === undefined) {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`)
  }
  return value
}
