import type { BenchmarkAdapter } from './benchmark-adapter.js'

export class BenchmarkRegistry {
  private readonly adapters = new Map<string, BenchmarkAdapter>()

  constructor(adapters: BenchmarkAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter)
    }
  }

  register(adapter: BenchmarkAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Benchmark adapter already registered: ${adapter.name}`)
    }
    this.adapters.set(adapter.name, adapter)
  }

  get(name: string): BenchmarkAdapter {
    const adapter = this.adapters.get(name)
    if (!adapter) {
      throw new Error(`Unknown benchmark adapter: ${name}`)
    }
    return adapter
  }

  has(name: string): boolean {
    return this.adapters.has(name)
  }

  names(): string[] {
    return [...this.adapters.keys()].sort()
  }
}
