import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface LoadedInstruction {
  readonly file: string
  readonly content: string
  readonly kind: 'personality' | 'project' | 'conventions'
}

const SOURCES = [
  { file: 'SOUL.md', kind: 'personality' as const },
  { file: 'AGENTS.md', kind: 'project' as const },
  { file: 'CLAUDE.md', kind: 'project' as const },
  { file: 'CONVENTIONS.md', kind: 'conventions' as const },
]

export class InstructionLoader {
  async load(workspaceRoot: string): Promise<LoadedInstruction[]> {
    const loaded: LoadedInstruction[] = []
    for (const source of SOURCES) {
      const file = path.join(workspaceRoot, source.file)
      try {
        await access(file)
        const content = (await readFile(file, 'utf8')).trim()
        if (content) {
          loaded.push({ file, content, kind: source.kind })
        }
      } catch {
        // Missing or unreadable optional instruction files are ignored.
      }
    }
    return loaded
  }
}
