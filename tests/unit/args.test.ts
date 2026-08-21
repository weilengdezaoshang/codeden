import { describe, expect, it } from 'vitest'
import { firstPositional, hasFlag, readFlag, readRepeatedFlag } from '../../src/cli/args.js'

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

  it('reads boolean and repeated flags', () => {
    const argv = ['--allow-host-verification', '--test-arg=-m', '--test-arg', 'pytest']
    expect(hasFlag(argv, '--allow-host-verification')).toBe(true)
    expect(readRepeatedFlag(argv, '--test-arg')).toEqual(['-m', 'pytest'])
  })
})
