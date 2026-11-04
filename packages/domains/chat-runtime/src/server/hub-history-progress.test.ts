import { describe, expect, test } from 'vitest'
import { createHistoryProgress } from './hub-history-progress'

describe('relayed history progress', () => {
  test('a contiguous run is complete; one lost event stays behind', () => {
    const h = createHistoryProgress()
    for (const seq of [0, 1, 2]) h.observe('a', seq)
    expect(h.behind('a', 2)).toBe(false)
    h.observe('a', 4) // 3 never arrived
    expect(h.behind('a', 4)).toBe(true)
    h.settle('a', 4)
    expect(h.behind('a', 4)).toBe(false)
    h.observe('a', 5)
    expect(h.behind('a', 5)).toBe(false)
  })
  test('out-of-order arrival fills its gap', () => {
    const h = createHistoryProgress()
    for (const seq of [0, 2, 3, 1]) h.observe('a', seq)
    expect(h.behind('a', 3)).toBe(false)
  })
  test('unknown conversations: no events = complete, any event = behind', () => {
    const h = createHistoryProgress()
    expect(h.behind('new', -1)).toBe(false)
    expect(h.behind('new', 0)).toBe(true)
    // An older computer reports no sequence.
    h.settle('a', 7)
    expect(h.behind('a', undefined)).toBe(true)
  })
  test('settling keeps events relayed past the computer report', () => {
    const h = createHistoryProgress()
    h.settle('a', 9)
    h.observe('a', 11)
    h.observe('a', 10)
    h.settle('a', 9)
    expect(h.behind('a', 11)).toBe(false)
  })
  test('a gap that never fills stops buffering and stays behind until settled', () => {
    const h = createHistoryProgress({ maxAhead: 3 })
    for (const seq of [1, 2, 3, 4, 5]) h.observe('a', seq) // 0 is missing
    expect(h.behind('a', 0)).toBe(true)
    h.settle('a', 5)
    expect(h.behind('a', 5)).toBe(false)
  })
})
