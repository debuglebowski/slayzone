import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { lazyWithPreload, preloadOnIdle } from './lazy-with-preload'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('lazyWithPreload', () => {
  it('preload and render share one factory call', async () => {
    const factory = vi.fn(async () => ({ default: () => <p>loaded</p> }))
    const Comp = lazyWithPreload(factory)
    await Comp.preload()
    render(
      <Suspense fallback={null}>
        <Comp />
      </Suspense>
    )
    expect(await screen.findByText('loaded')).toBeTruthy()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('a failed preload does not poison the later render', async () => {
    const factory = vi
      .fn<() => Promise<{ default: () => React.JSX.Element }>>()
      .mockRejectedValueOnce(new Error('chunk fetch failed'))
      .mockResolvedValue({ default: () => <p>retried</p> })
    const Comp = lazyWithPreload(factory)
    await expect(Comp.preload()).rejects.toThrow('chunk fetch failed')
    render(
      <Suspense fallback={null}>
        <Comp />
      </Suspense>
    )
    expect(await screen.findByText('retried')).toBeTruthy()
    expect(factory).toHaveBeenCalledTimes(2)
  })
})

type IdleCb = (deadline: IdleDeadline) => void

function fakeIdle() {
  const pending: IdleCb[] = []
  vi.stubGlobal('requestIdleCallback', (cb: IdleCb) => pending.push(cb))
  vi.stubGlobal('cancelIdleCallback', () => {})
  return {
    get pending() {
      return pending.length
    },
    /** Fire the oldest scheduled idle callback with `remaining` ms of idle time. */
    async fire(remaining: number, didTimeout = false) {
      const cb = pending.shift()
      if (!cb) throw new Error('no idle callback scheduled')
      cb({ didTimeout, timeRemaining: () => remaining })
      // Let the awaited loader settle and the next callback get scheduled.
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}

describe('preloadOnIdle', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads one chunk per idle period, in order', async () => {
    const idle = fakeIdle()
    const order: string[] = []
    preloadOnIdle([async () => order.push('a'), async () => order.push('b')])
    await idle.fire(50)
    expect(order).toEqual(['a'])
    await idle.fire(50)
    expect(order).toEqual(['a', 'b'])
    expect(idle.pending).toBe(0)
  })

  it('waits for a longer idle period when the current one is too short', async () => {
    const idle = fakeIdle()
    const load = vi.fn(async () => {})
    preloadOnIdle([load])
    await idle.fire(1)
    expect(load).not.toHaveBeenCalled()
    await idle.fire(50)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('runs on timeout even if never idle', async () => {
    const idle = fakeIdle()
    const load = vi.fn(async () => {})
    preloadOnIdle([load])
    await idle.fire(0, true)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('continues past a failing loader', async () => {
    const idle = fakeIdle()
    const next = vi.fn(async () => {})
    preloadOnIdle([() => Promise.reject(new Error('boom')), next])
    await idle.fire(50)
    await idle.fire(50)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('cancel stops the queue', async () => {
    const idle = fakeIdle()
    const second = vi.fn(async () => {})
    const cancel = preloadOnIdle([async () => cancel(), second])
    await idle.fire(50)
    expect(idle.pending).toBe(0)
    expect(second).not.toHaveBeenCalled()
  })
})
