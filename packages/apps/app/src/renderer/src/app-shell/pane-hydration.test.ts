import { describe, expect, it } from 'vitest'
import { ALL_HYDRATED_MARK, createPaneHydrator, HYDRATE_IDLE_TIMEOUT_MS } from './pane-hydration'

type IdleCb = (d: { didTimeout: boolean; timeRemaining: () => number }) => void

function harness() {
  const idle: Array<{ cb: IdleCb; timeout: number }> = []
  const flushed: string[] = []
  const h = createPaneHydrator({
    requestIdle: (cb, timeout) => idle.push({ cb, timeout }),
    flush: (fn) => {
      flushed.push('flush')
      fn()
    }
  })
  /** `remaining`: what the idle period reports left, read after each pane. */
  const runIdle = (remaining: number[] = [0]): void => {
    const next = idle.shift()
    if (!next) throw new Error('no idle callback scheduled')
    let i = 0
    next.cb({
      didTimeout: false,
      timeRemaining: () => remaining[Math.min(i++, remaining.length - 1)]
    })
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  return { h, idle, runIdle, flush, flushed }
}

describe('pane hydrator', () => {
  it('hydrates one ready pane per short idle callback, best rank first', async () => {
    const { h, idle, runIdle, flush } = harness()
    const rank: Record<string, number> = { a: 2, b: 0, c: 1 }
    for (const id of ['a', 'b', 'c'])
      h.enqueue(id, { rank: () => rank[id], ready: Promise.resolve() })
    await flush()
    expect(idle).toHaveLength(1)
    expect(idle[0].timeout).toBe(HYDRATE_IDLE_TIMEOUT_MS)

    runIdle()
    expect(['a', 'b', 'c'].filter((id) => h.isHydrated(id))).toEqual(['b'])
    runIdle()
    expect(h.isHydrated('c')).toBe(true)
    expect(h.isHydrated('a')).toBe(false)
    runIdle()
    expect(h.isHydrated('a')).toBe(true)
    expect(idle).toHaveLength(0)
  })

  it('reads rank at pick time (live MRU), FIFO on ties', async () => {
    const { h, runIdle, flush } = harness()
    const rank: Record<string, number> = { a: 5, b: 5, c: 5 }
    for (const id of ['a', 'b', 'c'])
      h.enqueue(id, { rank: () => rank[id], ready: Promise.resolve() })
    await flush()
    runIdle()
    expect(h.isHydrated('a')).toBe(true)
    rank.c = 0
    runIdle()
    expect(h.isHydrated('c')).toBe(true)
    expect(h.isHydrated('b')).toBe(false)
  })

  it('waits for a pane to be ready (data loaded), whatever its rank', async () => {
    const { h, idle, runIdle, flush } = harness()
    let resolveA!: () => void
    h.enqueue('a', { rank: () => 0, ready: new Promise<void>((r) => (resolveA = r)) })
    h.enqueue('b', { rank: () => 9, ready: Promise.resolve() })
    await flush()
    runIdle()
    expect(h.isHydrated('b')).toBe(true)
    expect(h.isHydrated('a')).toBe(false)
    expect(idle).toHaveLength(0) // nothing ready → no idle callback spinning
    resolveA()
    await flush()
    runIdle()
    expect(h.isHydrated('a')).toBe(true)
  })

  it('a failed load still hydrates (the pane shows its error boundary as before)', async () => {
    const { h, runIdle, flush } = harness()
    h.enqueue('a', { rank: () => 0, ready: Promise.reject(new Error('x')) })
    await flush()
    runIdle()
    expect(h.isHydrated('a')).toBe(true)
  })

  it('hydrateNow skips the queue, notifies, and is permanent', async () => {
    const { h, idle, flush } = harness()
    const seen: string[] = []
    h.subscribe('a', () => seen.push('a'))
    h.enqueue('a', { rank: () => 0, ready: new Promise(() => {}) })
    h.hydrateNow('a')
    h.hydrateNow('a')
    expect(h.isHydrated('a')).toBe(true)
    expect(seen).toEqual(['a'])
    // Already hydrated: enqueueing again is a no-op.
    h.enqueue('a', { rank: () => 0, ready: Promise.resolve() })
    await flush()
    expect(idle).toHaveLength(0)
  })

  it('a cancelled entry (pane unmounted) is never hydrated', async () => {
    const { h, idle, flush } = harness()
    const cancel = h.enqueue('a', { rank: () => 0, ready: Promise.resolve() })
    cancel()
    await flush()
    expect(idle).toHaveLength(0)
    expect(h.isHydrated('a')).toBe(false)
  })

  it('subscribers only hear their own pane', async () => {
    const { h, runIdle, flush } = harness()
    const seen: string[] = []
    const off = h.subscribe('b', () => seen.push('b'))
    h.subscribe('a', () => seen.push('a'))
    h.enqueue('a', { rank: () => 0, ready: Promise.resolve() })
    h.enqueue('b', { rank: () => 1, ready: Promise.resolve() })
    await flush()
    runIdle()
    expect(seen).toEqual(['a'])
    off()
    runIdle()
    expect(seen).toEqual(['a'])
    expect(h.isHydrated('b')).toBe(true)
  })

  it('fills an idle period with room left, and stops when it runs short', async () => {
    const { h, idle, runIdle, flush, flushed } = harness()
    for (const id of ['a', 'b', 'c', 'd'])
      h.enqueue(id, { rank: () => 0, ready: Promise.resolve() })
    await flush()
    // 45ms left after the first pane, 30 after the second, 10 after the third.
    runIdle([45, 30, 10])
    expect(['a', 'b', 'c', 'd'].filter((id) => h.isHydrated(id))).toEqual(['a', 'b', 'c'])
    expect(flushed).toHaveLength(3) // each pane rendered inside the callback
    expect(idle).toHaveLength(1)
    runIdle()
    expect(h.isHydrated('d')).toBe(true)
  })

  it('a timed-out idle callback (busy thread) hydrates exactly one pane', async () => {
    const { h, idle, flush } = harness()
    for (const id of ['a', 'b']) h.enqueue(id, { rank: () => 0, ready: Promise.resolve() })
    await flush()
    idle.shift()!.cb({ didTimeout: true, timeRemaining: () => 49 })
    expect(h.isHydrated('a')).toBe(true)
    expect(h.isHydrated('b')).toBe(false)
  })

  it('marks the drain of the boot queue once, not the on-screen pane before it', async () => {
    performance.clearMarks(ALL_HYDRATED_MARK)
    const { h, runIdle, flush } = harness()
    h.hydrateNow('active')
    expect(performance.getEntriesByName(ALL_HYDRATED_MARK)).toHaveLength(0)
    for (const id of ['a', 'b']) h.enqueue(id, { rank: () => 0, ready: Promise.resolve() })
    await flush()
    runIdle([0])
    expect(performance.getEntriesByName(ALL_HYDRATED_MARK)).toHaveLength(0)
    runIdle([0])
    expect(performance.getEntriesByName(ALL_HYDRATED_MARK)).toHaveLength(1)
    h.enqueue('c', { rank: () => 0, ready: Promise.resolve() })
    await flush()
    runIdle([0])
    expect(performance.getEntriesByName(ALL_HYDRATED_MARK)).toHaveLength(1)
  })
})
