import { describe, expect, it } from 'vitest'
import {
  CodeDenDockerHarness,
  HarnessRegistry,
  NativeHarness,
  SweBenchOfficialHarness,
  SwePolyBenchDockerHarness,
  TerminalBenchDockerHarness,
  createHarnessRegistry,
} from '../../apps/eval-platform/src/platform/harness.js'

describe('评测 Harness Registry', () => {
  it('注册并按类型选择内置 Harness', () => {
    const registry = createHarnessRegistry()
    expect(registry.get('native')).toBeInstanceOf(NativeHarness)
    expect(registry.get('codeden-docker')).toBeInstanceOf(CodeDenDockerHarness)
    expect(registry.get('swebench-official')).toBeInstanceOf(SweBenchOfficialHarness)
    expect(registry.get('swe-polybench-docker')).toBeInstanceOf(SwePolyBenchDockerHarness)
    expect(registry.get('terminal-bench-docker')).toBeInstanceOf(TerminalBenchDockerHarness)
  })

  it('拒绝重复注册和未注册的 Harness', () => {
    const registry = new HarnessRegistry().register(new NativeHarness())
    expect(() => registry.register(new NativeHarness())).toThrow('Harness 已注册：native')
    expect(() => registry.get('swebench-official')).toThrow('Harness 未注册：swebench-official')
  })
})
