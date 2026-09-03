import type { BenchmarkPort } from '../../ports/benchmark.port.js'

/** External and native benchmark implementations share the same runtime contract. */
export type BenchmarkAdapter = BenchmarkPort
