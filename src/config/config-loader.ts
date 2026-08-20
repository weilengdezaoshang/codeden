import { readFile, stat } from 'node:fs/promises'
import { YAMLError, parse as parseYaml } from 'yaml'
import { candidateConfigPaths } from './config-locator.js'
import { configNotFound, configReadFailed, configYamlInvalid } from './config-errors.js'
import { assertNoLiteralSecrets, parseCodeDenConfig } from './config-validator.js'
import type { CodeDenConfig } from './config-schema.js'

const MAX_CONFIG_BYTES = 256_000

export class ConfigLoader {
  async load(workspaceRoot: string, extraSearchRoots: string[] = []): Promise<CodeDenConfig> {
    const filePath = await this.resolveConfigPath(workspaceRoot, extraSearchRoots)
    const info = await stat(filePath)

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

    let parsed: unknown
    try {
      parsed = parseYaml(raw)
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

    return parseCodeDenConfig(parsed)
  }

  async resolveConfigPath(workspaceRoot: string, extraSearchRoots: string[] = []): Promise<string> {
    for (const filePath of candidateConfigPaths(workspaceRoot, extraSearchRoots)) {
      try {
        await stat(filePath)
        return filePath
      } catch {
        continue
      }
    }
    throw configNotFound(workspaceRoot)
  }
}
