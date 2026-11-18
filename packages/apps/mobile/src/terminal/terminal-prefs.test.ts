import { createTerminalPrefs, DEFAULT_TERMINAL_PREFS } from './terminal-prefs'

function memory(initial: string | null = null) {
  let text = initial
  return {
    read: () => text,
    write: (next: string) => {
      text = next
    },
    text: () => text
  }
}

describe('terminal prefs', () => {
  it('starts readable, and keeps the text size the user chose', () => {
    const store = memory()
    const prefs = createTerminalPrefs(store)
    expect(prefs.load()).toEqual(DEFAULT_TERMINAL_PREFS)
    expect(DEFAULT_TERMINAL_PREFS.textSize).toBe('readable')
    prefs.save({ textSize: 'fit' })
    expect(createTerminalPrefs(store).load()).toEqual({ textSize: 'fit' })
  })

  it('unreadable or foreign content is nothing kept', () => {
    expect(createTerminalPrefs(memory('{oops')).load()).toEqual(DEFAULT_TERMINAL_PREFS)
    expect(createTerminalPrefs(memory('{"textSize":"huge"}')).load()).toEqual(
      DEFAULT_TERMINAL_PREFS
    )
  })

  it('a failing write loses nothing else', () => {
    const prefs = createTerminalPrefs({
      read: () => null,
      write: () => {
        throw new Error('disk full')
      }
    })
    expect(() => prefs.save({ textSize: 'fit' })).not.toThrow()
  })
})
