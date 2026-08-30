import { readFile, stat } from 'node:fs/promises'
import { YAMLError, parse as parseYaml } from 'yaml'
import { candidateConfigPaths, locateUserConfig } from './config-locator.js'
import { configNotFound, configReadFailed, configYamlInvalid } from './config-errors.js'
import { assertNoLiteralSecrets, parseCodeDenConfig } from './config-validator.js'
import type { CodeDenConfig } from './config-schema.js'

const MAX_CONFIG_BYTES = 256_000

export interface ConfigLoaderOptions {
  /** 覆盖默认的 ~/.codeden/config.yaml，主要用于测试和嵌入式调用。 */
  userConfigPath?: string
}

type PlainObject = Record<string, unknown>

export class ConfigLoader {
  private readonly userConfigPath: string

  constructor(options: ConfigLoaderOptions = {}) {
    this.userConfigPath = options.userConfigPath ?? locateUserConfig()
  }

  async load(workspaceRoot: string, extraSearchRoots: string[] = []): Promise<CodeDenConfig> {
    const projectPath = await this.findExistingProjectConfig(workspaceRoot, extraSearchRoots)
    const layers: unknown[] = []

    // 低优先级配置先合并，高优先级配置后合并。项目级配置只需声明要覆盖的字段，
    // 例如只覆盖 agent.defaultModel 时，用户级 providers 仍然会被保留。
    if (await this.exists(this.userConfigPath)) {
      layers.push(await this.readAndParse(this.userConfigPath))
    }
    if (projectPath) {
      const project = await this.readAndParse(projectPath)
      if (
        isPlainObject(project) &&
        isPlainObject(project.telemetry) &&
        ('enabled' in project.telemetry || 'consentId' in project.telemetry)
      ) {
        throw configReadFailed('Trace 上传授权只能在用户级配置中设置，项目配置不能授予上传权限')
      }
      layers.push(project)
    }
    if (layers.length === 0) {
      throw configNotFound(workspaceRoot)
    }

    return parseCodeDenConfig(layers.reduce((merged, layer) => deepMerge(merged, layer), {}))
  }

  async resolveConfigPath(workspaceRoot: string, extraSearchRoots: string[] = []): Promise<string> {
    const projectPath = await this.findExistingProjectConfig(workspaceRoot, extraSearchRoots)
    if (projectPath) {
      return projectPath
    }
    if (await this.exists(this.userConfigPath)) {
      return this.userConfigPath
    }
    throw configNotFound(workspaceRoot)
  }

  private async findExistingProjectConfig(
    workspaceRoot: string,
    extraSearchRoots: string[],
  ): Promise<string | undefined> {
    for (const filePath of candidateConfigPaths(workspaceRoot, extraSearchRoots)) {
      if (await this.exists(filePath)) {
        return filePath
      }
    }
    return undefined
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath)
      return true
    } catch (error) {
      if (isMissingPathError(error)) {
        return false
      }
      throw configReadFailed(error instanceof Error ? error.message : 'stat failed')
    }
  }

  private async readAndParse(filePath: string): Promise<unknown> {
    let info
    try {
      info = await stat(filePath)
    } catch (error) {
      throw configReadFailed(error instanceof Error ? error.message : 'stat failed')
    }
    if (info.size > MAX_CONFIG_BYTES) {
      throw configReadFailed(`配置文件超过 ${MAX_CONFIG_BYTES} 字节`)
    }

    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      throw configReadFailed(error instanceof Error ? error.message : 'read failed')
    }

    assertNoLiteralSecrets(raw)

    try {
      return parseYaml(raw)
    } catch (error) {
      if (error instanceof YAMLError) {
        const line = error.linePos?.[0]?.line ?? '?'
        const col = error.linePos?.[0]?.col ?? '?'
        throw configYamlInvalid(`${filePath}:${line}:${col}`, error.message)
      }
      throw configYamlInvalid(
        filePath,
        error instanceof Error ? error.message : 'yaml parse failed',
      )
    }
  }
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false
  }
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override
  }

  const result: PlainObject = { ...base }
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : value
  }
  return result
}
