import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: ['core', 'agent-runtime', 'telemetry', 'eval-engine', 'agent', 'eval-platform'].map(
      (name) => ({
        find: new RegExp(`^@codeden/${name}/(.*)\\.js$`),
        replacement: fileURLToPath(
          new URL(
            `${name === 'agent' || name === 'eval-platform' ? 'apps' : 'packages'}/${name}/src/$1.ts`,
            import.meta.url,
          ),
        ),
      }),
    ),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
})
