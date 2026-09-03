export interface DocsSearchResult {
  title: string
  url: string
}

export interface DocsSearchProvider {
  readonly name: string
  search(input: {
    query: string
    trustedDomains: string[]
    maxResults: number
    signal?: AbortSignal
  }): Promise<DocsSearchResult[]>
}
