import { describe, expect, it } from 'vitest'
import { hasLineLongerThan } from './long-lines'

describe('hasLineLongerThan', () => {
  it('finds a long line anywhere', () => {
    expect(hasLineLongerThan('abcd', 3)).toBe(true)
    expect(hasLineLongerThan('a\nb\nabcd', 3)).toBe(true)
    expect(hasLineLongerThan('abcd\nb', 3)).toBe(true)
  })

  it('a line of exactly the limit is not longer', () => {
    expect(hasLineLongerThan('abc\nabc\n', 3)).toBe(false)
    expect(hasLineLongerThan('', 0)).toBe(false)
  })

  it('counts CRLF line ends with the line, never across lines', () => {
    expect(hasLineLongerThan('abc\r\nabc', 3)).toBe(true)
    expect(hasLineLongerThan('ab\r\nab', 3)).toBe(false)
  })
})
