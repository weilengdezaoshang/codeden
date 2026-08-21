import { describe, expect, it } from 'vitest'
import { BenchmarkRegistry } from '../../src/eval/adapters/benchmarks/benchmark-registry.js'
import type { BenchmarkAdapter } from '../../src/eval/adapters/benchmarks/benchmark-adapter.js'

function adapter(name: string): BenchmarkAdapter {
  return {
    name,
    async *load() {},
    async prepare() {
      throw new Error('not implemented')
    },
    async verify() {
      throw new Error('not implemented')
    },
  }
}

describe('BenchmarkRegistry', () => {
  it('registers and resolves adapters by name', () => {
    const native = adapter('native')
    const registry = new BenchmarkRegistry([native])
    expect(registry.get('native')).toBe(native)
    expect(registry.names()).toEqual(['native'])
  })

  it('rejects duplicate and unknown adapters', () => {
    const registry = new BenchmarkRegistry([adapter('native')])
    expect(() => registry.register(adapter('native'))).toThrow('already registered')
    expect(() => registry.get('missing')).toThrow('Unknown benchmark adapter')
  })
})
