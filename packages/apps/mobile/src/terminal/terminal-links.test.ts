import { urlAtCell } from './terminal-links'

/** Buffer lines of `cols` columns: `[text, isWrapped]`, padded as xterm's are. */
function buffer(cols: number, lines: Array<[string, boolean?]>) {
  return (y: number) => {
    const line = lines[y]
    if (!line) return undefined
    return {
      isWrapped: line[1] ?? false,
      translateToString: (trimRight?: boolean) =>
        trimRight ? line[0].trimEnd() : line[0].padEnd(cols, ' ')
    }
  }
}

describe('urlAtCell', () => {
  it('finds the web link under a cell', () => {
    const get = buffer(40, [['see https://example.com/a?b=1 for more']])
    expect(urlAtCell(get, 0, 10)).toBe('https://example.com/a?b=1')
    expect(urlAtCell(get, 0, 4)).toBe('https://example.com/a?b=1')
    expect(urlAtCell(get, 0, 2)).toBeNull()
    expect(urlAtCell(get, 0, 35)).toBeNull()
  })

  it('leaves trailing punctuation out, as desktop does', () => {
    const get = buffer(40, [['(open http://localhost:3000).']])
    expect(urlAtCell(get, 0, 10)).toBe('http://localhost:3000')
  })

  it('joins a link the terminal wrapped onto the next lines', () => {
    const get = buffer(10, [
      ['go https:/'],
      ['/example.c', true],
      ['om/x done', true],
      ['next line']
    ])
    expect(urlAtCell(get, 1, 3)).toBe('https://example.com/x')
    expect(urlAtCell(get, 0, 5)).toBe('https://example.com/x')
    expect(urlAtCell(get, 2, 1)).toBe('https://example.com/x')
    expect(urlAtCell(get, 3, 1)).toBeNull()
  })

  it('no line there: no link', () => {
    expect(urlAtCell(buffer(10, []), 4, 0)).toBeNull()
  })
})
