import { describe, expect, it } from 'vitest'
import { parsePersonaCommand } from '../../src/cli/agent-command.js'

describe('parsePersonaCommand', () => {
  it('supports show, clear and set commands', () => {
    expect(parsePersonaCommand('/persona')).toEqual({ type: 'show' })
    expect(parsePersonaCommand('/persona clear')).toEqual({ type: 'clear' })
    expect(parsePersonaCommand('/persona concise and direct')).toEqual({
      type: 'set',
      value: 'concise and direct',
    })
  })

  it('treats blank values as show and rejects similar prefixes', () => {
    expect(parsePersonaCommand('/persona   ')).toEqual({ type: 'show' })
    expect(parsePersonaCommand('/personality concise')).toBeUndefined()
    expect(parsePersonaCommand('persona concise')).toBeUndefined()
  })
})
