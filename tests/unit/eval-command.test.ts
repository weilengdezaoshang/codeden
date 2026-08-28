import { describe, expect, it, vi } from 'vitest'
import { main } from '../../src/cli/eval-command.js'

describe('测试套件：eval command dataset policy', () => {
  it('验证：requires a dataset checksum before any external dataset is read', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await main([
      '--benchmark',
      'swebench-lite',
      '--dataset',
      'missing.jsonl',
      '--version',
      '1.0',
      '--license',
      'MIT',
      '--test-command',
      'python',
      '--allow-host-verification',
    ])
    expect(code).toBe(2)
    expect(output).toHaveBeenCalledWith('SWE-bench requires --sha256')
    output.mockRestore()
  })
})
