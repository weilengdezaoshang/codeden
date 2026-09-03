import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigLoader } from '../../../packages/core/src/config/config-loader.js'

const VALID = `
schemaVersion: 1
agent:
  defaultProvider: deepseek
  defaultModel: deepseek-chat
providers:
  deepseek:
    type: openai-compatible
    baseURL: https://api.deepseek.com
    apiKey:
      from: env
      name: DEEPSEEK_API_KEY
    defaultModel: deepseek-chat
    capabilities:
      tools: true
`

describe('测试套件：ConfigLoader', () => {
  it('验证：loads an env secret reference', async () => {
    const root = await workspaceWith(VALID)
    const config = await new ConfigLoader().load(root)
    expect(config.agent.defaultProvider).toBe('deepseek')
    expect(config.providers.deepseek?.apiKey).toEqual({ from: 'env', name: 'DEEPSEEK_API_KEY' })
    expect(config.network.docs.enabled).toBe(true)
    expect(config.network.docs.allowedDomains).toContain('nodejs.org')
    expect(config.telemetry).toEqual({
      enabled: false,
      traceRetentionDays: 30,
      maxTraceFiles: 500,
    })
  })

  it('验证：rejects missing files', async () => {
    await expect(new ConfigLoader().load(await emptyRoot())).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
    })
  })

  it('验证：loads config from cwd when the workspace has none', async () => {
    const configRoot = await workspaceWith(VALID)
    const workspace = await emptyRoot()
    const config = await new ConfigLoader().load(workspace, [configRoot])
    expect(config.agent.defaultProvider).toBe('deepseek')
  })

  it('验证：loads a user config when no project config exists', async () => {
    const workspace = await emptyRoot()
    const userHome = await emptyRoot()
    const userConfigPath = await writeUserConfig(userHome, VALID)

    const config = await new ConfigLoader({ userConfigPath }).load(workspace)

    expect(config.agent.defaultProvider).toBe('deepseek')
  })

  it('验证：merges project config over user config while retaining env references', async () => {
    const userHome = await emptyRoot()
    const userConfigPath = await writeUserConfig(
      userHome,
      VALID.replace('name: DEEPSEEK_API_KEY', 'name: USER_DEEPSEEK_API_KEY'),
    )
    const project = await workspaceWith(`
schemaVersion: 1
agent:
  defaultProvider: deepseek
  defaultModel: project-model
providers:
  deepseek:
    defaultModel: project-model
`)

    const config = await new ConfigLoader({ userConfigPath }).load(project)

    expect(config.agent.defaultModel).toBe('project-model')
    expect(config.providers.deepseek?.defaultModel).toBe('project-model')
    expect(config.providers.deepseek?.apiKey).toEqual({
      from: 'env',
      name: 'USER_DEEPSEEK_API_KEY',
    })
  })

  it('验证：gives project config priority when both config files exist', async () => {
    const userHome = await emptyRoot()
    const userConfigPath = await writeUserConfig(userHome, VALID)
    const project = await workspaceWith(
      VALID.replace('defaultProvider: deepseek', 'defaultProvider: project-provider').replace(
        'deepseek:',
        'project-provider:',
      ),
    )

    const resolved = await new ConfigLoader({ userConfigPath }).resolveConfigPath(project)

    expect(resolved).toBe(path.join(project, '.codeden', 'config.yaml'))
  })

  it('验证：rejects literal secrets in a lower-priority user config', async () => {
    const userHome = await emptyRoot()
    const userConfigPath = await writeUserConfig(
      userHome,
      VALID.replace('from: env', 'from: literal'),
    )
    const project = await workspaceWith(VALID)

    await expect(new ConfigLoader({ userConfigPath }).load(project)).rejects.toMatchObject({
      code: 'SECRET_LITERAL_FORBIDDEN',
    })
  })

  it('验证：does not pick a parent of the workspace over extra search roots', async () => {
    const decoy = await workspaceWith(
      VALID.replace('defaultProvider: deepseek', 'defaultProvider: openai').replace(
        'deepseek:',
        'openai:',
      ),
    )
    const nested = path.join(decoy, 'nested-ws')
    await mkdir(nested)
    const configRoot = await workspaceWith(VALID)
    const config = await new ConfigLoader().load(nested, [configRoot])
    expect(config.agent.defaultProvider).toBe('deepseek')
  })

  it('验证：rejects literal secrets', async () => {
    const root = await workspaceWith(VALID.replace('from: env', 'from: literal'))
    await expect(new ConfigLoader().load(root)).rejects.toMatchObject({
      code: 'SECRET_LITERAL_FORBIDDEN',
    })
  })

  it('验证：rejects a missing default provider', async () => {
    const root = await workspaceWith(
      VALID.replace('defaultProvider: deepseek', 'defaultProvider: missing'),
    )
    await expect(new ConfigLoader().load(root)).rejects.toMatchObject({
      code: 'CONFIG_SCHEMA_INVALID',
    })
  })

  it('验证：loads an explicit documentation domain allowlist', async () => {
    const root = await workspaceWith(
      `${VALID}\nnetwork:\n  docs:\n    enabled: true\n    allowedDomains:\n      - docs.example.com\n`,
    )
    const config = await new ConfigLoader().load(root)
    expect(config.network.docs.allowedDomains).toEqual(['docs.example.com'])
  })

  it('验证：loads explicit Docker daemon settings for command sandboxing', async () => {
    const root = await workspaceWith(
      `${VALID}\nnetwork:\n  commands:\n    mode: docker\n    image: node:24-bookworm-slim\n    dockerContext: colima\n    readOnly: true\n`,
    )
    const config = await new ConfigLoader().load(root)
    expect(config.network.commands).toMatchObject({
      mode: 'docker',
      dockerContext: 'colima',
      readOnly: true,
    })
  })

  it('验证：加载 Docker 沙箱资源限制配置', async () => {
    const root = await workspaceWith(
      `${VALID}\nnetwork:\n  commands:\n    mode: docker\n    cpus: 2\n    memoryLimit: 512m\n    tmpfsSize: 128m\n    pidsLimit: 128\n`,
    )
    const config = await new ConfigLoader().load(root)

    expect(config.network.commands).toMatchObject({
      mode: 'docker',
      cpus: 2,
      memoryLimit: '512m',
      tmpfsSize: '128m',
      pidsLimit: 128,
    })
  })

  it('验证：拒绝无效的 Docker 沙箱资源限制', async () => {
    const root = await workspaceWith(
      `${VALID}\nnetwork:\n  commands:\n    cpus: 0\n    memoryLimit: unlimited\n    tmpfsSize: 0x10\n    pidsLimit: 0\n`,
    )

    await expect(new ConfigLoader().load(root)).rejects.toMatchObject({
      code: 'CONFIG_SCHEMA_INVALID',
    })
  })

  it('验证：rejects conflicting Docker daemon settings', async () => {
    const root = await workspaceWith(
      `${VALID}\nnetwork:\n  commands:\n    dockerContext: colima\n    dockerHost: unix:///tmp/docker.sock\n`,
    )
    await expect(new ConfigLoader().load(root)).rejects.toMatchObject({
      code: 'CONFIG_SCHEMA_INVALID',
    })
  })

  it('验证：rejects an invalid Docker host address', async () => {
    const root = await workspaceWith(`${VALID}\nnetwork:\n  commands:\n    dockerHost: invalid\n`)
    await expect(new ConfigLoader().load(root)).rejects.toMatchObject({
      code: 'CONFIG_SCHEMA_INVALID',
    })
  })

  it('验证：启用 Trace 上传队列时必须明确授权标识', async () => {
    const root = await emptyRoot()
    const userConfigPath = await writeUserConfig(
      await emptyRoot(),
      `${VALID}\ntelemetry:\n  enabled: true\n`,
    )
    await expect(new ConfigLoader({ userConfigPath }).load(root)).rejects.toMatchObject({
      code: 'CONFIG_SCHEMA_INVALID',
    })

    await writeFile(
      userConfigPath,
      `${VALID}\ntelemetry:\n  enabled: true\n  consentId: local-consent\n`,
    )
    expect((await new ConfigLoader({ userConfigPath }).load(root)).telemetry).toMatchObject({
      enabled: true,
      consentId: 'local-consent',
    })
  })

  it('验证：项目不能伪造用户的 Trace 上传授权', async () => {
    const root = await workspaceWith(`${VALID}\ntelemetry:\n  enabled: true\n  consentId: forged\n`)
    await expect(new ConfigLoader().load(root)).rejects.toThrow('上传授权只能在用户级配置')
  })
})

async function workspaceWith(content: string): Promise<string> {
  const root = await emptyRoot()
  await mkdir(path.join(root, '.codeden'), { recursive: true })
  await writeFile(path.join(root, '.codeden', 'config.yaml'), content, 'utf8')
  return root
}

async function writeUserConfig(userHome: string, content: string): Promise<string> {
  const configPath = path.join(userHome, '.codeden', 'config.yaml')
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, content, 'utf8')
  return configPath
}

async function emptyRoot(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(path.join(tmpdir(), 'codeden-config-'))
}
