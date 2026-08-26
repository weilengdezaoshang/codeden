import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface LoadedInstruction {
  readonly file: string
  readonly content: string
  readonly kind: 'personality' | 'project' | 'conventions'
}

const SOURCES = [
  { file: path.join('.codeden', 'SOUL.md'), kind: 'personality' as const },
  { file: path.join('.codeden', 'instructions.md'), kind: 'project' as const },
  { file: 'SOUL.md', kind: 'personality' as const },
  { file: 'AGENTS.md', kind: 'project' as const },
  { file: 'CLAUDE.md', kind: 'project' as const },
  { file: 'CONVENTIONS.md', kind: 'conventions' as const },
]

type InstructionReader = (file: string, encoding: 'utf8') => Promise<string>

export class InstructionLoader {
  constructor(
    private readonly maxChars = 20_000,
    private readonly read: InstructionReader = (file, encoding) => readFile(file, encoding),
  ) {
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      throw new Error('Instruction maxChars must be a positive integer')
    }
  }

  async load(workspaceRoot: string): Promise<LoadedInstruction[]> {
    const loaded: LoadedInstruction[] = []
    for (const source of SOURCES) {
      const file = path.join(workspaceRoot, source.file)
      try {
        await access(file)
        const raw = (await this.read(file, 'utf8')).trim()
        const content =
          raw.length > this.maxChars
            ? `${raw.slice(0, this.maxChars)}\n[Instruction truncated]`
            : raw
        if (content) {
          loaded.push({ file, content, kind: source.kind })
        }
      } catch {
        // Missing or unreadable optional instruction files are ignored.
      }
    }
    return loaded
  }

  async loadHierarchy(workspaceRoot: string): Promise<LoadedInstruction[]> {
    const workspace = path.resolve(workspaceRoot)
    const boundary = await this.findBoundary(workspace)
    const roots: string[] = []
    let current = workspace
    while (true) {
      roots.unshift(current)
      if (current === boundary) {
        break
      }
      const parent = path.dirname(current)
      current = parent
    }
    const loaded: LoadedInstruction[] = []
    for (const root of roots) {
      loaded.push(...(await this.load(root)))
    }
    return loaded
  }

  private async findBoundary(start: string): Promise<string> {
    let current = start
    while (true) {
      try {
        await access(path.join(current, '.git'))
        return current
      } catch {
        const parent = path.dirname(current)
        if (parent === current) {
          return start
        }
        current = parent
      }
    }
  }
}
