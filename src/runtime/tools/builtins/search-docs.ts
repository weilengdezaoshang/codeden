import { z } from 'zod'
import { guardOf, redactorOf } from '../../../security/tool-security.js'
import type { DocsNetworkPolicy } from '../../network/docs-network-policy.js'
import type { DocsSearchProvider } from '../../research/docs-search-provider.js'
import type { Tool, ToolContext } from '../tool.js'

export const SearchDocsInputSchema = z.object({
  query: z.string().trim().min(2).max(240),
  maxResults: z.number().int().min(1).max(10).default(5),
})

export type SearchDocsInput = z.infer<typeof SearchDocsInputSchema>

export class SearchDocsTool implements Tool<SearchDocsInput> {
  readonly name = 'search_docs'
  readonly description =
    'Search trusted official documentation when local project evidence is insufficient. Use concise technical queries without secrets or private source code, then call fetch_url on relevant results.'
  readonly inputSchema = SearchDocsInputSchema
  readonly sideEffect = 'read' as const

  constructor(
    private readonly policy: DocsNetworkPolicy,
    private readonly provider: DocsSearchProvider,
  ) {}

  async execute(input: SearchDocsInput, context: ToolContext) {
    const query = redactorOf(context).redact(input.query)
    guardOf(context).assertSafe(query, 'tool:search_docs:request')
    if (looksLikeSourcePayload(query)) {
      throw new Error(
        'Documentation search queries must describe a question, not include source code or payloads',
      )
    }
    const candidates = await this.provider.search({
      query,
      trustedDomains: this.policy.trustedDomains(),
      maxResults: input.maxResults * 3,
      signal: context.abortSignal,
    })
    const results: Array<{ title: string; url: string; domain: string }> = []
    for (const candidate of candidates) {
      if (results.length >= input.maxResults) {
        break
      }
      try {
        const url = await this.policy.assertAllowed(candidate.url)
        results.push({
          title: redactorOf(context).redact(candidate.title),
          url: url.toString(),
          domain: url.hostname,
        })
      } catch {
        continue
      }
    }
    return {
      query,
      provider: this.provider.name,
      results,
      trustedDomains: this.policy.trustedDomains(),
      evidenceOnly: true,
    }
  }
}

function looksLikeSourcePayload(query: string): boolean {
  return (
    query.includes('```') ||
    /(?:process\.env|authorization\s*:|api[_-]?key\s*[:=]|-----BEGIN )/iu.test(query) ||
    (query.includes('{') && query.includes('}')) ||
    query.split('\n').length > 1
  )
}
