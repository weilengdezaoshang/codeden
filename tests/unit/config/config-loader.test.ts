import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigLoader } from '../../../src/config/config-loader.js'

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

describe('ConfigLoader', () => {
  it('loads an env secret reference', async () => {
    const root = await workspaceWith(VALID)
    const config = await new ConfigLoader().load(root)
    expect(config.agent.defaultProvider).toBe('deepseek')
    expect(config.providers.deepseek?.apiKey).toEqual({ from: 'env', name: 'DEEPSEEK_API_KEY' })
    expect(config.network.docs.enabled).toBe(true)
    expect(config.network.docs.allowedDomains).toContain('nodejs.org')
  })

  it('rejects missing files', async () => {
    await expect(new ConfigLoader().load(await emptyRoot())).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
    })
  })

  it('loads config from cwd when the workspace has none', async () => {
    const configRoot = await workspaceWith(VALID)
    const workspace = await emptyRoot()
    const config = await new ConfigLoader().load(workspace, [configRoot])
    expect(config.agent.defaultProvider).toBe('deepseek')
  })

  it('does not pick a parent of the workspace over extra search roots', async () => {
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

  it('rejects literal secrets', async () => {
    const root = await workspaceWith(VALID.replace('from: env', 'from: literal'))
    await expect(new ConfigLoader().load(root)).rejects.toMatchObject({
      code: 'SECRET_LITERAL_FORBIDDEN',
    })
  })

  it('rejects a missing default provider', async () => {
    const root = await workspaceWith(
      VALID.replace('defaultProvider: deepseek', 'defaultProvider: missing'),
    )
    await expect(new ConfigLoader().load(root)).rejects.toMatchObject({
      code: 'CONFIG_SCHEMA_INVALID',
    })
  })

  it('loads an explicit documentation domain allowlist', async () => {
    const root = await workspaceWith(
      `${VALID}\nnetwork:\n  docs:\n    enabled: true\n    allowedDomains:\n      - docs.example.com\n`,
    )
    const config = await new ConfigLoader().load(root)
    expect(config.network.docs.allowedDomains).toEqual(['docs.example.com'])
  })

  it('loads explicit Docker daemon settings for command sandboxing', async () => {
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

  it('rejects conflicting Docker daemon settings', async () => {
    const root = await workspaceWith(
      `${VALID}\nnetwork:\n  commands:\n    dockerContext: colima\n    dockerHost: unix:///tmp/docker.sock\n`,
    )
    await expect(new ConfigLoader().load(root)).rejects.toMatchObject({
      code: 'CONFIG_SCHEMA_INVALID',
    })
  })

  it('rejects an invalid Docker host address', async () => {
    const root = await workspaceWith(`${VALID}\nnetwork:\n  commands:\n    dockerHost: invalid\n`)
    await expect(new ConfigLoader().load(root)).rejects.toMatchObject({
      code: 'CONFIG_SCHEMA_INVALID',
    })
  })
})

async function workspaceWith(content: string): Promise<string> {
  const root = await emptyRoot()
  await mkdir(path.join(root, '.codeden'), { recursive: true })
  await writeFile(path.join(root, '.codeden', 'config.yaml'), content, 'utf8')
  return root
}

async function emptyRoot(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(path.join(tmpdir(), 'codeden-config-'))
}
