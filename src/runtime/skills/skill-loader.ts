import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface SkillDefinition {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly allowedTools: readonly string[]
  readonly userInvocable: boolean
  readonly prompt: string
  readonly source: 'user' | 'project'
  readonly filePath: string
}

export interface SkillLoaderOptions {
  projectRoot: string
  userHome?: string
}

/** Loads declarative SKILL.md files without executing skill-owned code. */
export class SkillLoader {
  constructor(private readonly options: SkillLoaderOptions) {}

  async discover(): Promise<SkillDefinition[]> {
    const roots = [
      {
        root: path.join(this.options.userHome ?? os.homedir(), '.codeden', 'skills'),
        source: 'user' as const,
      },
      {
        root: path.join(this.options.projectRoot, '.codeden', 'skills'),
        source: 'project' as const,
      },
    ]
    const byName = new Map<string, SkillDefinition>()
    for (const item of roots) {
      for (const skill of await this.readRoot(item.root, item.source)) {
        byName.set(skill.name, skill)
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private async readRoot(root: string, source: 'user' | 'project'): Promise<SkillDefinition[]> {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) {
        return []
      }
      throw error
    }
    const result: SkillDefinition[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const filePath = path.join(root, entry.name, 'SKILL.md')
      try {
        await stat(filePath)
      } catch {
        continue
      }
      const raw = await readFile(filePath, 'utf8')
      const parsed = parseSkill(raw)
      if (!parsed.name || !parsed.description) {
        continue
      }
      result.push({
        name: parsed.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        allowedTools: parsed.allowedTools,
        userInvocable: parsed.userInvocable,
        prompt: parsed.prompt,
        source,
        filePath,
      })
    }
    return result
  }
}

function parseSkill(raw: string): {
  name: string
  description: string
  whenToUse?: string
  allowedTools: string[]
  userInvocable: boolean
  prompt: string
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/u)
  if (!match) {
    return { name: '', description: '', allowedTools: [], userInvocable: true, prompt: raw.trim() }
  }
  const frontmatter = (parseYaml(match[1] ?? '') ?? {}) as Record<string, unknown>
  const tools = frontmatter['allowed-tools'] ?? frontmatter.allowedTools
  return {
    name: typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '',
    description: typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
    whenToUse:
      typeof frontmatter.when_to_use === 'string' ? frontmatter.when_to_use.trim() : undefined,
    allowedTools: Array.isArray(tools)
      ? tools.filter((tool): tool is string => typeof tool === 'string')
      : [],
    userInvocable: frontmatter['user-invocable'] !== false,
    prompt: (match[2] ?? '').trim(),
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
