import { CodeDenError } from '@codeden/core/errors/codeden-error.js'
import { ErrorCodes } from '@codeden/core/errors/error-codes.js'
import type { DocsSearchProvider, DocsSearchResult } from './docs-search-provider.js'

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
const SEARCH_TIMEOUT_MS = 8_000
const MAX_SEARCH_RESPONSE_BYTES = 256_000

export class DuckDuckGoDocsSearchProvider implements DocsSearchProvider {
  readonly name = 'duckduckgo'

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(input: {
    query: string
    trustedDomains: string[]
    maxResults: number
    signal?: AbortSignal
  }): Promise<DocsSearchResult[]> {
    const scopedQuery = `${input.query} (${input.trustedDomains
      .map((domain) => `site:${domain}`)
      .join(' OR ')})`
    const url = new URL(SEARCH_ENDPOINT)
    url.searchParams.set('q', scopedQuery)
    let response: Response
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    input.signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'text/html' },
      })
    } catch (error) {
      throw searchError(error instanceof Error ? error.message : 'Documentation search failed')
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
    }
    if (!response.ok) {
      throw searchError(`Documentation search failed with HTTP ${response.status}`)
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
    if (contentType && contentType !== 'text/html') {
      throw searchError(`Documentation search returned an unexpected content type: ${contentType}`)
    }
    return parseResults(await readBoundedText(response)).slice(0, input.maxResults)
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_SEARCH_RESPONSE_BYTES) {
    throw searchError(`Documentation search response exceeds ${MAX_SEARCH_RESPONSE_BYTES} bytes`)
  }
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    size += value.byteLength
    if (size > MAX_SEARCH_RESPONSE_BYTES) {
      await reader.cancel()
      throw searchError(`Documentation search response exceeds ${MAX_SEARCH_RESPONSE_BYTES} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function parseResults(html: string): DocsSearchResult[] {
  const results: DocsSearchResult[] = []
  const links = html.matchAll(
    /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
  )
  for (const match of links) {
    const rawUrl = decodeHtml(match[1] ?? '')
    const url = unwrapRedirect(rawUrl)
    const title = decodeHtml((match[2] ?? '').replace(/<[^>]+>/gu, '')).trim()
    if (url && title) {
      results.push({ title, url })
    }
  }
  return results
}

function unwrapRedirect(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl, SEARCH_ENDPOINT)
    const redirected = parsed.searchParams.get('uddg')
    return redirected ? decodeURIComponent(redirected) : parsed.toString()
  } catch {
    return undefined
  }
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function searchError(message: string): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.TOOL_EXECUTION_FAILED,
    category: 'tool',
    message,
    retryable: true,
  })
}
