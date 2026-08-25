export function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item) {
      continue
    }
    if (item === name) {
      return argv[index + 1]
    }
    if (item.startsWith(prefix)) {
      return item.slice(prefix.length)
    }
  }
  return undefined
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

export function readRepeatedFlag(argv: string[], name: string): string[] {
  const values: string[] = []
  const prefix = `${name}=`
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === name && argv[index + 1] !== undefined) {
      values.push(argv[index + 1]!)
      index += 1
    } else if (item?.startsWith(prefix)) {
      values.push(item.slice(prefix.length))
    }
  }
  return values
}

export function firstPositional(argv: string[]): string | undefined {
  const valueFlags = new Set([
    '--workspace',
    '--provider',
    '--model',
    '--prompt',
    '--max-turns',
    '--max-tool-calls',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item) {
      continue
    }
    if (item.startsWith('--')) {
      if (valueFlags.has(item) && !item.includes('=')) {
        index += 1
      }
      continue
    }
    if (item.startsWith('-')) {
      continue
    }
    return item
  }
  return undefined
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
