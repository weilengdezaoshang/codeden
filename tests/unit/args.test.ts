import { describe, expect, it } from 'vitest'
import { firstPositional, readFlag } from '../../src/cli/args.js'

describe('CLI args', () => {
  it('reads a separate flag value', () => {
    expect(readFlag(['--workspace', '/tmp/ws', 'task'], '--workspace')).toBe('/tmp/ws')
  })

  it('reads an equals-form flag', () => {
    expect(readFlag(['--workspace=/tmp/ws', 'task'], '--workspace')).toBe('/tmp/ws')
  })

  it('keeps the prompt when a flag uses equals form', () => {
    expect(firstPositional(['--workspace=/tmp/ws', '将 package.json 改成 2.0.0'])).toBe(
      '将 package.json 改成 2.0.0',
    )
  })
})
