import { ctrlChar, KEY_BAR, KeyRepeater, keyBytes } from './key-bar'

const key = (id: string) => {
  const found = KEY_BAR.find((k) => k.id === id)
  if (!found) throw new Error(`no key ${id}`)
  return found
}

describe('key bar', () => {
  it('has the keys a phone keyboard lacks, plus answers to an agent’s questions', () => {
    expect(KEY_BAR.map((k) => k.label)).toEqual([
      'Esc',
      'Ctrl',
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

  it('Ctrl is a modifier: it sends nothing itself, the next character goes as Ctrl+it', () => {
    const ctrl = key('ctrl')
    expect(ctrl.modifier).toBe(true)
    expect(ctrlChar('c')).toBe('\x03')
    expect(ctrlChar('Z')).toBe('\x1a')
    expect(ctrlChar('[')).toBe('\x1b')
    expect(ctrlChar(' ')).toBe('\x00')
    expect(ctrlChar('?')).toBe('\x7f')
    expect(ctrlChar('é')).toBeNull()
  })

  it('arrows repeat while held', () => {
    expect(KEY_BAR.filter((k) => k.repeats).map((k) => k.id)).toEqual([
      'up',
      'down',
      'left',
      'right'
    ])
  })
})

describe('KeyRepeater', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('sends once on press, then again and again after a pause, until released', () => {
    const sent: number[] = []
    const r = new KeyRepeater()
    r.press(() => sent.push(1))
    expect(sent).toHaveLength(1)
    jest.advanceTimersByTime(KeyRepeater.DELAY_MS - 1)
    expect(sent).toHaveLength(1)
    jest.advanceTimersByTime(1 + KeyRepeater.INTERVAL_MS * 3)
    expect(sent).toHaveLength(5)
    r.release()
    jest.advanceTimersByTime(1_000)
    expect(sent).toHaveLength(5)
  })

  it('a new press replaces the held one', () => {
    const sent: string[] = []
    const r = new KeyRepeater()
    r.press(() => sent.push('a'))
    r.press(() => sent.push('b'))
    jest.advanceTimersByTime(KeyRepeater.DELAY_MS)
    expect(sent).toEqual(['a', 'b', 'b'])
    r.release()
  })
})
