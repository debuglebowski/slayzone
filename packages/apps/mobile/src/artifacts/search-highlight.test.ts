import { highlightParts } from './search-highlight'

const plain = { caseSensitive: false, regex: false }

describe('highlightParts', () => {
  it('marks every match, case-insensitively by default', () => {
    expect(highlightParts('Plan the plan', 'plan', plain)).toEqual([
      { text: 'Plan', match: true },
      { text: ' the ', match: false },
      { text: 'plan', match: true }
    ])
  })

  it('takes the query literally unless it is a regular expression', () => {
    expect(highlightParts('a.b axb', 'a.b', plain).filter((p) => p.match)).toEqual([
      { text: 'a.b', match: true }
    ])
    expect(
      highlightParts('a.b axb', 'a.b', { caseSensitive: false, regex: true }).filter((p) => p.match)
    ).toHaveLength(2)
  })

  it('respects Match case; an invalid pattern or empty matches highlight nothing', () => {
    expect(highlightParts('Plan', 'plan', { caseSensitive: true, regex: false })).toEqual([
      { text: 'Plan', match: false }
    ])
    expect(highlightParts('x(', '(', { caseSensitive: false, regex: true })).toEqual([
      { text: 'x(', match: false }
    ])
    expect(highlightParts('abc', 'z*', { caseSensitive: false, regex: true })).toEqual([
      { text: 'abc', match: false }
    ])
  })
})
