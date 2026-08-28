import { describe, expect, it, vi } from 'vitest'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { DocsNetworkPolicy } from '../../src/runtime/network/docs-network-policy.js'
import { FetchUrlTool } from '../../src/runtime/tools/builtins/fetch-url.js'
import { SearchDocsTool } from '../../src/runtime/tools/builtins/search-docs.js'
import { createDefaultToolRegistry } from '../../src/runtime/create-codeden-runtime.js'
import { WorkspacePolicy } from '../../src/runtime/workspace/workspace-policy.js'
import { ResolvedSecret } from '../../src/security/resolved-secret.js'
import { createSecurityServices } from '../../src/security/security-services.js'

describe('测试套件：documentation network policy', () => {
  it('验证：allows an HTTPS URL on an exact allowlisted public domain', async () => {
    const policy = new DocsNetworkPolicy({
      allowedDomains: ['nodejs.org'],
      resolveHost: async () => ['104.20.1.252'],
    })
    await expect(policy.assertAllowed('https://nodejs.org/api/fs.html')).resolves.toMatchObject({
      hostname: 'nodejs.org',
    })
  })

  it('验证：registers fetch_url only when a documentation policy is provided', () => {
    const policy = new DocsNetworkPolicy({
      allowedDomains: ['nodejs.org'],
      resolveHost: async () => ['104.20.1.252'],
    })
    expect(createDefaultToolRegistry().get('fetch_url')).toBeUndefined()
    expect(createDefaultToolRegistry(policy).get('fetch_url')).toBeInstanceOf(FetchUrlTool)
    expect(createDefaultToolRegistry(policy).get('search_docs')).toBeUndefined()
    expect(
      createDefaultToolRegistry(policy, { name: 'fake', search: async () => [] }).get(
        'search_docs',
      ),
    ).toBeInstanceOf(SearchDocsTool)
  })

  it('验证：rejects unlisted domains and domains resolving to private addresses', async () => {
    const publicPolicy = new DocsNetworkPolicy({
      allowedDomains: ['nodejs.org'],
      resolveHost: async () => ['104.20.1.252'],
    })
    await expect(publicPolicy.assertAllowed('https://example.com')).rejects.toThrow('not allowed')

    const privatePolicy = new DocsNetworkPolicy({
      allowedDomains: ['docs.internal.test'],
      resolveHost: async () => ['127.0.0.1'],
    })
    await expect(privatePolicy.assertAllowed('https://docs.internal.test')).rejects.toThrow(
      'private',
    )
  })

  it('验证：fetches bounded text and marks it as untrusted', async () => {
    const policy = new DocsNetworkPolicy({
      allowedDomains: ['nodejs.org'],
      resolveHost: async () => ['104.20.1.252'],
    })
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response('Official documentation', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      ),
    ) as unknown as typeof fetch
    const output = await new FetchUrlTool(policy, fetchImpl).execute(
      { url: 'https://nodejs.org/api/fs.html' },
      context(),
    )
    expect(output).toMatchObject({
      content: 'Official documentation',
      untrustedContent: true,
    })
  })

  it('验证：validates every redirect target against the allowlist', async () => {
    const policy = new DocsNetworkPolicy({
      allowedDomains: ['nodejs.org'],
      resolveHost: async () => ['104.20.1.252'],
    })
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/steal' },
        }),
      ),
    ) as unknown as typeof fetch
    await expect(
      new FetchUrlTool(policy, fetchImpl).execute(
        { url: 'https://nodejs.org/api/fs.html' },
        context(),
      ),
    ).rejects.toThrow('not allowed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('验证：redacts known secrets from downloaded documentation', async () => {
    const policy = new DocsNetworkPolicy({
      allowedDomains: ['nodejs.org'],
      resolveHost: async () => ['104.20.1.252'],
    })
    const security = createSecurityServices()
    security.registry.register(new ResolvedSecret('sentinel-secret-value'))
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response('token=sentinel-secret-value', {
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    ) as unknown as typeof fetch
    const output = await new FetchUrlTool(policy, fetchImpl).execute(
      { url: 'https://nodejs.org/api/fs.html' },
      { ...context(), security },
    )
    expect(JSON.stringify(output)).not.toContain('sentinel-secret-value')
  })

  it('验证：blocks known secrets before sending the request', async () => {
    const policy = new DocsNetworkPolicy({
      allowedDomains: ['nodejs.org'],
      resolveHost: async () => ['104.20.1.252'],
    })
    const security = createSecurityServices()
    security.registry.register(new ResolvedSecret('sentinel-secret-value'))
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      new FetchUrlTool(policy, fetchImpl).execute(
        { url: 'https://nodejs.org/search?q=sentinel-secret-value' },
        { ...context(), security },
      ),
    ).rejects.toThrow('Secret leak blocked')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

function context() {
  const root = process.cwd()
  const eventSink = new NoopEventSink()
  return {
    workspaceRoot: root,
    policy: new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: true,
    }),
    eventSink,
  }
}
