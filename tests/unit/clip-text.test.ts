import { describe, expect, it } from 'vitest'
import {
  capIdentities,
  clipHeadTail,
  createBoundedBuffer,
} from '../../src/runtime/verification/clip-text.js'

describe('clipHeadTail', () => {
  it('keeps short text unchanged', () => {
    expect(clipHeadTail('hello', 100)).toBe('hello')
  })

  it('keeps the head and tail of long text', () => {
    const text = 'H'.repeat(50) + 'M'.repeat(100) + 'T'.repeat(50)
    const clipped = clipHeadTail(text, 80)
    expect(clipped.length).toBeLessThan(text.length)
    expect(clipped.startsWith('H')).toBe(true)
    expect(clipped.endsWith('T')).toBe(true)
    expect(clipped).toContain('[truncated]')
  })
})

describe('createBoundedBuffer', () => {
  it('drops the middle once the cap is exceeded', () => {
    const buffer = createBoundedBuffer(20)
    buffer.push('HEADDATA')
    buffer.push('MIDDLE-MIDDLE-MIDDLE')
    buffer.push('TAILDATA')
    const value = buffer.toString()
    expect(value).toContain('[truncated]')
    expect(value.length).toBeLessThan(20 + 30)
  })
})

describe('capIdentities', () => {
  it('summarizes overflow identities', () => {
    const items = Array.from({ length: 25 }, (_, index) => `t${index}`)
    const capped = capIdentities(items, 3)
    expect(capped).toEqual(['t0', 't1', 't2', '...and 22 more'])
  })
})
