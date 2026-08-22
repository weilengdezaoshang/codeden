import { describe, expect, it, vi } from 'vitest'
import { NoopEventSink } from '../../src/core/events/event-sink.js'
import { DocsNetworkPolicy } from '../../src/runtime/network/docs-network-policy.js'
import { DuckDuckGoDocsSearchProvider } from '../../src/runtime/research/duckduckgo-docs-search-provider.js'
import type { DocsSearchProvider } from '../../src/runtime/research/docs-search-provider.js'
import { SearchDocsTool } from '../../src/runtime/tools/builtins/search-docs.js'
import { WorkspacePolicy } from '../../src/runtime/workspace/workspace-policy.js'

describe('SearchDocsTool', () => {
  it('returns only results from trusted official domains', async () => {
    const provider: DocsSearchProvider = {
      name: 'fake',
      async search() {
        return [
          { title: 'Node docs', url: 'https://nodejs.org/api/fs.html' },
          { title: 'Untrusted', url: 'https://example.com/copied-docs' },
        ]
      },
    }
    const policy = new DocsNetworkPolicy({
      allowedDomains: ['nodejs.org'],
      resolveHost: async () => ['104.20.1.252'],
    })
    const output = await new SearchDocsTool(policy, provider).execute(
      { query: 'Node.js file system API', maxResults: 5 },
      context(),
    )
    expect(output).toMatchObject({
      provider: 'fake',
      evidenceOnly: true,
      results: [{ title: 'Node docs', domain: 'nodejs.org' }],
    })
  })

  it('parses search-provider redirect links without trusting their domains', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html">
        Node.js File system
      </a>
    `
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(new Response(html, { headers: { 'content-type': 'text/html' } })),
    ) as unknown as typeof fetch
    const results = await new DuckDuckGoDocsSearchProvider(fetchImpl).search({
      query: 'file system',
      trustedDomains: ['nodejs.org'],
      maxResults: 5,
    })
    expect(results).toEqual([
      { title: 'Node.js File system', url: 'https://nodejs.org/api/fs.html' },
    ])
  })

  it('rejects source-code and multiline queries before external search', async () => {
    const provider: DocsSearchProvider = {
      name: 'fake',
      async search() {
        throw new Error('provider should not be called')
      },
    }
    const policy = new DocsNetworkPolicy({
      allowedDomains: ['nodejs.org'],
      resolveHost: async () => ['104.20.1.252'],
    })
    await expect(
      new SearchDocsTool(policy, provider).execute(
        { query: '查这个代码：\n```ts\nconst token = process.env.API_KEY\n```', maxResults: 5 },
        context(),
      ),
    ).rejects.toThrow('source code or payloads')
  })
})

function context() {
  const root = process.cwd()
  return {
    workspaceRoot: root,
    policy: new WorkspacePolicy(root, {
      readableRoots: ['.'],
      writableRoots: ['.'],
      allowCommands: true,
    }),
    eventSink: new NoopEventSink(),
  }
}
