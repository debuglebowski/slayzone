import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithSecurityContext } from '@slayzone/platform/security-log'
import { createNotifyCoalescer } from './notify-coalescer'

type Change = { taskIds: readonly string[] }

function setup(windowMs = 200) {
  const delivered: (string[] | null)[] = []
  const c = createNotifyCoalescer<Change>(
    (ids) => delivered.push(ids === null ? null : [...ids].sort()),
    (change) => change?.taskIds,
    windowMs
  )
  return { c, delivered }
}

describe('createNotifyCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('delivers an isolated signal at once (no added latency)', () => {
    const { c, delivered } = setup()
    c.push({ taskIds: ['a'] })
    expect(delivered).toEqual([['a']])
    vi.advanceTimersByTime(1000)
    expect(delivered).toEqual([['a']])
  })

  it('merges a burst into one trailing delivery with the union of ids', () => {
    const { c, delivered } = setup()
    c.push({ taskIds: ['a'] })
    c.push({ taskIds: ['b'] })
    c.push({ taskIds: ['c', 'b'] })
    expect(delivered).toEqual([['a']])
    vi.advanceTimersByTime(200)
    expect(delivered).toEqual([['a'], ['b', 'c']])
    vi.advanceTimersByTime(1000)
    expect(delivered).toHaveLength(2)
  })

  it('any unscoped signal in a window makes the merged delivery unscoped', () => {
    const { c, delivered } = setup()
    c.push({ taskIds: ['a'] })
    c.push({ taskIds: ['b'] })
    c.push()
    vi.advanceTimersByTime(200)
    expect(delivered).toEqual([['a'], null])
  })

  it('an unscoped leading signal is delivered unscoped', () => {
    const { c, delivered } = setup()
    c.push()
    expect(delivered).toEqual([null])
  })

  it('a sustained stream delivers at most once per window', () => {
    const { c, delivered } = setup()
    for (let t = 0; t < 1000; t += 10) {
      c.push({ taskIds: [`t${t}`] })
      vi.advanceTimersByTime(10)
    }
    vi.advanceTimersByTime(400)
    // 1 leading + one per elapsed 200ms window (1000ms of pushes → 5) ± the tail.
    expect(delivered.length).toBeGreaterThanOrEqual(5)
    expect(delivered.length).toBeLessThanOrEqual(7)
    // Nothing lost: every id was delivered.
    const all = new Set(delivered.flatMap((d) => d ?? []))
    expect(all.size).toBe(100)
  })

  it('reopens after a quiet window: the next signal is immediate again', () => {
    const { c, delivered } = setup()
    c.push({ taskIds: ['a'] })
    vi.advanceTimersByTime(200) // window closes empty
    c.push({ taskIds: ['b'] })
    expect(delivered).toEqual([['a'], ['b']])
  })

  it('keeps each acting user in its own bucket (owner-gate attribution)', () => {
    const { c, delivered } = setup()
    runWithSecurityContext({ ip: null, route: null, actor: 'u1' }, () =>
      c.push({ taskIds: ['a'] })
    )
    runWithSecurityContext({ ip: null, route: null, actor: 'u2' }, () =>
      c.push({ taskIds: ['b'] })
    )
    // Both leading: different actors never merge.
    expect(delivered).toEqual([['a'], ['b']])
  })

  it('stops delivering after dispose', () => {
    const { c, delivered } = setup()
    c.push({ taskIds: ['a'] })
    c.push({ taskIds: ['b'] })
    c.dispose()
    vi.advanceTimersByTime(1000)
    c.push({ taskIds: ['c'] })
    expect(delivered).toEqual([['a']])
  })
})
