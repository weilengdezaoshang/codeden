import { z } from 'zod'
import { guardOf } from '../tool-security.js'
import type { Tool, ToolContext } from '../tool.js'
import { DuckDuckGoDocsSearchProvider } from '../../research/duckduckgo-docs-search-provider.js'

const InputSchema = z.object({
  query: z.string().trim().min(2).max(500),
  domains: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  maxResults: z.number().int().min(1).max(20).default(8),
})
export type WebSearchInput = z.infer<typeof InputSchema>

export class WebSearchTool implements Tool<WebSearchInput> {
  readonly name = 'web_search'
  readonly description = 'Search the public web and return untrusted result links and titles.'
  readonly inputSchema = InputSchema
  readonly sideEffect = 'read' as const

  constructor(private readonly provider = new DuckDuckGoDocsSearchProvider()) {}

  async execute(input: WebSearchInput, context: ToolContext) {
    guardOf(context).assertSafe(input.query, 'tool:web_search:request')
    const results = await this.provider.search({
      query: input.query,
      trustedDomains: input.domains,
      maxResults: input.maxResults,
      signal: context.abortSignal,
    })
    return { query: input.query, results, untrustedContent: true }
  }
}
