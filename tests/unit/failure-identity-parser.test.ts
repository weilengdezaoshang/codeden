import { describe, expect, it } from 'vitest'
import {
  fingerprintOutput,
  parseFailingIdentities,
} from '../../src/runtime/verification/failure-identity-parser.js'

describe('parseFailingIdentities', () => {
  it('reads TAP not ok names and file locations', () => {
    const output = `
TAP version 13
# Subtest: tests/old-fail.test.js
    not ok 1 - pre-existing failure
      ---
      location: 'tests/old-fail.test.js:4:1'
      ...
not ok 1 - tests/old-fail.test.js
`
    expect(parseFailingIdentities(output)).toEqual([
      'pre-existing failure',
      'tests/old-fail.test.js',
    ])
  })

  it('reads Vitest FAIL file paths', () => {
    expect(parseFailingIdentities('FAIL tests/ok.test.ts\n✓ other')).toEqual(['tests/ok.test.ts'])
  })
})

describe('fingerprintOutput', () => {
  it('ignores duration noise', () => {
    const a = fingerprintOutput('not ok 1 - x\nduration_ms: 1.23\n')
    const b = fingerprintOutput('not ok 1 - x\nduration_ms: 9.99\n')
    expect(a).toBe(b)
    expect(a).toHaveLength(16)
  })
})
