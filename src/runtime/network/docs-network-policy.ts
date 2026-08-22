import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'

export interface DocsNetworkPolicyOptions {
  allowedDomains: string[]
  resolveHost?: (hostname: string) => Promise<string[]>
}

export class DocsNetworkPolicy {
  private readonly allowedDomains: Set<string>
  private readonly resolveHost: (hostname: string) => Promise<string[]>

  constructor(options: DocsNetworkPolicyOptions) {
    this.allowedDomains = new Set(options.allowedDomains.map(normalizeDomain))
    this.resolveHost = options.resolveHost ?? resolveAll
  }

  trustedDomains(): string[] {
    return [...this.allowedDomains].sort()
  }

  async assertAllowed(input: string): Promise<URL> {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      throw denied('Invalid documentation URL')
    }
    if (url.protocol !== 'https:') {
      throw denied('Documentation URL must use HTTPS')
    }
    if (url.username || url.password || (url.port && url.port !== '443')) {
      throw denied('Documentation URL cannot contain credentials or a custom port')
    }

    const hostname = normalizeDomain(url.hostname)
    if (!this.allowedDomains.has(hostname)) {
      throw denied(`Documentation domain is not allowed: ${hostname}`)
    }
    if (isIP(hostname) !== 0) {
      throw denied('IP address URLs are not allowed')
    }
    const addresses = await this.resolveHost(hostname)
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw denied(`Documentation domain resolves to a private or unavailable address: ${hostname}`)
    }
    return url
  }
}

async function resolveAll(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/u, '')
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLowerCase()
    if (normalized.startsWith('::ffff:')) {
      return isPrivateAddress(normalized.slice('::ffff:'.length))
    }
    return !(normalized.startsWith('2') || normalized.startsWith('3'))
  }
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return true
  }
  const [a, b] = octets as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  )
}

function denied(message: string): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.TOOL_EXECUTION_FAILED,
    category: 'permission',
    message,
    retryable: false,
  })
}
