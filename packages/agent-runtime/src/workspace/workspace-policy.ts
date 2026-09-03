import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { denyPath, resolveInsideRoot } from './path-guard.js'

export interface WorkspacePolicyConfig {
  readableRoots: string[]
  writableRoots: string[]
  allowCommands: boolean
}

export class WorkspacePolicy {
  constructor(
    readonly workspaceRoot: string,
    private readonly config: WorkspacePolicyConfig,
  ) {}

  async resolveReadable(inputPath: string): Promise<string> {
    const resolved = await resolveInsideRoot(this.workspaceRoot, inputPath)
    if (!(await this.isUnderAny(resolved, this.config.readableRoots))) {
      denyPath(inputPath, `Read is not allowed: ${inputPath}`)
    }
    return resolved
  }

  async resolveWritable(inputPath: string): Promise<string> {
    const resolved = await resolveInsideRoot(this.workspaceRoot, inputPath)
    if (!(await this.isUnderAny(resolved, this.config.writableRoots))) {
      denyPath(inputPath, `Write is not allowed: ${inputPath}`)
    }
    return resolved
  }

  assertCommandsAllowed(options: { readOnly?: boolean } = {}): void {
    if (!this.config.allowCommands && !options.readOnly) {
      denyPath('<command>', 'Commands are not allowed in this workspace')
    }
  }

  private async isUnderAny(resolved: string, roots: string[]): Promise<boolean> {
    const realRoot = await realpath(this.workspaceRoot)
    return roots.some((root) => {
      const allowed = path.resolve(realRoot, root)
      if (resolved === allowed) {
        return true
      }
      const relative = path.relative(allowed, resolved)
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    })
  }
}
