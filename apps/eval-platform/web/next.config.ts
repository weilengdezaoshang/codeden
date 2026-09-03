import type { NextConfig } from 'next'

const config: NextConfig = {
  serverExternalPackages: [
    '@codeden/eval-platform',
    '@codeden/core',
    '@codeden/agent-runtime',
    '@codeden/eval-engine',
    'pg',
    'pg-boss',
    'drizzle-orm',
  ],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]
  },
}
export default config
