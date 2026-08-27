import { describe, expect, it } from 'vitest'
import { maxTerminalScroll, wrapTerminalText } from '../../src/cli/terminal-ui.js'

describe('terminal layout helpers', () => {
  it('clamps scroll to the actual viewport', () => {
    expect(maxTerminalScroll(10, 4)).toBe(6)
    expect(maxTerminalScroll(2, 4)).toBe(0)
    expect(maxTerminalScroll(10, 0)).toBe(9)
  })

  it('wraps text without splitting surrogate pairs', () => {
    expect(wrapTerminalText('abcdef', 3)).toEqual(['abc', 'def'])
    expect(wrapTerminalText('😀😀', 1)).toEqual(['😀', '😀'])
    expect(wrapTerminalText('', 3)).toEqual([''])
  })
})
