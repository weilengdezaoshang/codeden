import { describe, expect, it } from 'vitest'

/**
 * Manual smoke:
 *   OPENAI_API_KEY=sk-... CODEDEN_OPENAI_SMOKE=1 pnpm test tests/integration/openai-smoke.test.ts
 *
 * Default CI must stay offline and not require a key.
 */
const enabled = process.env.CODEDEN_OPENAI_SMOKE === '1' && Boolean(process.env.OPENAI_API_KEY)

describe.skipIf(!enabled)('OpenAI smoke', () => {
  it('completes a read-only prompt through the real provider', async () => {
    const { OpenAIModelProvider } =
      await import('../../packages/agent-runtime/src/models/openai-model-provider.js')
    const provider = new OpenAIModelProvider()
    const response = await provider.complete({
      messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
      tools: [],
    })
    expect(response.text.toLowerCase()).toContain('pong')
    expect(response.toolCalls).toEqual([])
  })
})
