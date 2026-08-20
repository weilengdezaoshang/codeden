import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ProjectFacts } from './project-facts.js'

const execFileAsync = promisify(execFile)

const PackageJsonSchema = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
})

export class ProjectInspector {
  async inspect(root: string): Promise<ProjectFacts> {
    const packageJsonPath = path.join(root, 'package.json')
    const hasPackageJson = await exists(packageJsonPath)
    const parsed = hasPackageJson ? await readPackageJson(packageJsonPath) : null
    const scripts = parsed?.scripts ?? {}

    return {
      root,
      packageManager: await detectPackageManager(root, parsed?.packageManager),
      hasPackageJson,
      scripts: {
        ...(typeof scripts.test === 'string' ? { test: scripts.test } : {}),
        ...(typeof scripts.typecheck === 'string' ? { typecheck: scripts.typecheck } : {}),
        ...(typeof scripts.build === 'string' ? { build: scripts.build } : {}),
        ...(typeof scripts.lint === 'string' ? { lint: scripts.lint } : {}),
      },
      git: await inspectGit(root),
    }
  }
}

async function readPackageJson(filePath: string) {
  const raw = await readFile(filePath, 'utf8')
  const parsed = PackageJsonSchema.safeParse(JSON.parse(raw) as unknown)
  return parsed.success ? parsed.data : null
}

async function detectPackageManager(
  root: string,
  field: string | undefined,
): Promise<ProjectFacts['packageManager']> {
  if (field?.startsWith('pnpm')) {
    return 'pnpm'
  }
  if (field?.startsWith('yarn')) {
    return 'yarn'
  }
  if (field?.startsWith('npm')) {
    return 'npm'
  }
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }
  if (await exists(path.join(root, 'yarn.lock'))) {
    return 'yarn'
  }
  if (await exists(path.join(root, 'package-lock.json'))) {
    return 'npm'
  }
  return 'unknown'
}

async function inspectGit(root: string): Promise<ProjectFacts['git']> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root })
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: root })
    return { available: true, dirty: status.stdout.trim().length > 0 }
  } catch {
    return { available: false, dirty: false }
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}
