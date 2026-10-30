import { KEY_BAR, keyBytes } from './key-bar'

const key = (id: string) => {
  const found = KEY_BAR.find((k) => k.id === id)
  if (!found) throw new Error(`no key ${id}`)
  return found
}

describe('key bar', () => {
  it('has the keys a phone keyboard lacks, plus answers to an agent’s questions', () => {
    expect(KEY_BAR.map((k) => k.label)).toEqual([
      'Esc',
      '^C',
      '^D',
      'Tab',
      '⇧Tab',
      '↑',
      '↓',
      '←',
      '→',
      '⏎',
      '1',
      '2',
      '3'
    ])
  })

  it('sends the bytes a terminal sends for each key', () => {
    const normal = { applicationCursorKeys: false }
    expect(keyBytes(key('esc'), normal)).toBe('\x1b')
    expect(keyBytes(key('ctrl-c'), normal)).toBe('\x03')
    expect(keyBytes(key('ctrl-d'), normal)).toBe('\x04')
    expect(keyBytes(key('tab'), normal)).toBe('\t')
    expect(keyBytes(key('shift-tab'), normal)).toBe('\x1b[Z')
    expect(keyBytes(key('enter'), normal)).toBe('\r')
    expect(keyBytes(key('1'), normal)).toBe('1')
  })

  it('sends arrows in the cursor-key mode the program asked for', () => {
    expect(keyBytes(key('up'), { applicationCursorKeys: false })).toBe('\x1b[A')
    expect(keyBytes(key('up'), { applicationCursorKeys: true })).toBe('\x1bOA')
    expect(keyBytes(key('left'), { applicationCursorKeys: true })).toBe('\x1bOD')
  })

  it('marks the keys that interrupt the agent (Esc, Ctrl+C), as desktop does', () => {
    expect(KEY_BAR.filter((k) => k.interrupts).map((k) => k.id)).toEqual(['esc', 'ctrl-c'])
  })
})
