// @vitest-environment jsdom
// useStablePoll's refetch() is fired by fs-watcher events (git panel), often while a
// tick is still running. It must not overlap fetches, and must not fork a second timer
// chain: each refetch-during-a-tick used to leave the old chain running beside the new
// one, permanently multiplying the poll rate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useStablePoll } from './use-stable-poll'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useStablePoll', () => {
  it('refetch during a running tick → no overlap, one follow-up once it settles', async () => {
    const pending: Array<ReturnType<typeof deferred<string>>> = []
    let inFlight = 0
    let maxInFlight = 0
    const fetchFn = vi.fn(() => {
      const d = deferred<string>()
      pending.push(d)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return d.promise.finally(() => inFlight--)
    })
    const { result, unmount } = renderHook(() =>
      useStablePoll(fetchFn, { baseDelayMs: 1000, maxDelayMs: 1000 })
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)

    act(() => result.current.refetch())
    act(() => result.current.refetch())
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await act(async () => pending[0].resolve('a'))
    // Coalesced: two refetches during one tick → ONE follow-up, right away.
    expect(fetchFn).toHaveBeenCalledTimes(2)
    await act(async () => pending[1].resolve('b'))
    expect(maxInFlight).toBe(1)
    unmount()
  })

  it('a refetch during a running tick never forks a second timer chain', async () => {
    // Each fetch takes 100ms; refetch lands mid-fetch.
    const fetchFn = vi.fn(() => new Promise<string>((r) => setTimeout(() => r('same'), 100)))
    const { result, unmount } = renderHook(() =>
      useStablePoll(fetchFn, { baseDelayMs: 1000, maxDelayMs: 1000 })
    )
    for (let i = 0; i < 5; i++) {
      act(() => result.current.refetch())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150)
      })
    }
    fetchFn.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    // One chain: a tick every 1.1s (1s delay + 100ms fetch) → 9 in 10s, not 9 × chains.
    expect(fetchFn).toHaveBeenCalledTimes(9)
    unmount()
  })

  it('refetch while idle runs at once and resets the backoff', async () => {
    const fetchFn = vi.fn(async () => 'same')
    const { result, unmount } = renderHook(() =>
      useStablePoll(fetchFn, { baseDelayMs: 1000, maxDelayMs: 60_000 })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000) // backed off: 1s, 2s, 4s, 8s…
    })
    fetchFn.mockClear()
    await act(async () => result.current.refetch())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // Backoff restarts from the base: unchanged result → 2s (was 16s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    unmount()
  })
})
