/**
 * The suspend clock: when this process last came back from a freeze (host sleep,
 * VM suspend, a stopped debugger) — the window a watchdog must not judge.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAwakeTimeouts, createSuspendClock } from './suspend-clock'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

test('no freeze: nothing has resumed', () => {
  const clock = createSuspendClock({ tickMs: 1_000, toleranceMs: 2_000 })
  vi.advanceTimersByTime(60_000)
  expect(clock.lastResumeAt()).toBe(0)
  clock.dispose()
})

test('a freeze the ticker sees after it: resumed at the first tick after it', () => {
  const clock = createSuspendClock({ tickMs: 1_000, toleranceMs: 2_000 })
  vi.advanceTimersByTime(5_000)
  // The host sleeps 17 minutes: the wall clock jumps, no timer ran meanwhile.
  vi.setSystemTime(Date.now() + 17 * 60_000)
  const wokeAt = Date.now()
  vi.advanceTimersByTime(1_000)
  expect(clock.lastResumeAt()).toBeGreaterThanOrEqual(wokeAt)
  clock.dispose()
})

test('a freeze asked about before the ticker ran again: detected by the ask itself', () => {
  const clock = createSuspendClock({ tickMs: 1_000, toleranceMs: 2_000 })
  vi.advanceTimersByTime(5_000)
  vi.setSystemTime(Date.now() + 17 * 60_000)
  // A watchdog timer fires first on wake — before the ticker's own catch-up tick.
  expect(clock.lastResumeAt()).toBe(Date.now())
  clock.dispose()
})

test('event-loop lag within the tolerance is not a freeze', () => {
  const clock = createSuspendClock({ tickMs: 1_000, toleranceMs: 2_000 })
  vi.advanceTimersByTime(1_000)
  vi.setSystemTime(Date.now() + 1_500)
  vi.advanceTimersByTime(1_000)
  expect(clock.lastResumeAt()).toBe(0)
  clock.dispose()
})

test('awake time: a freeze the ticker sees does not count', () => {
  const clock = createSuspendClock({ tickMs: 1_000, toleranceMs: 2_000 })
  const start = clock.awakeNow()
  vi.advanceTimersByTime(5_000)
  vi.setSystemTime(Date.now() + 17 * 60_000)
  vi.advanceTimersByTime(1_000)
  // 6s of running; the 17-minute sleep is gone. One tick of slack: the freeze is
  // measured from the last tick before it.
  expect(clock.awakeNow() - start).toBeGreaterThanOrEqual(5_000)
  expect(clock.awakeNow() - start).toBeLessThanOrEqual(7_000)
  clock.dispose()
})

test('awake time: a freeze asked about before the ticker ran again does not count', () => {
  const clock = createSuspendClock({ tickMs: 1_000, toleranceMs: 2_000 })
  const start = clock.awakeNow()
  vi.advanceTimersByTime(5_000)
  vi.setSystemTime(Date.now() + 17 * 60_000)
  expect(clock.awakeNow() - start).toBeLessThanOrEqual(6_000)
  clock.dispose()
})

test('awake time: event-loop lag within the tolerance still counts', () => {
  const clock = createSuspendClock({ tickMs: 1_000, toleranceMs: 2_000 })
  const start = clock.awakeNow()
  vi.advanceTimersByTime(1_000)
  vi.setSystemTime(Date.now() + 1_500)
  vi.advanceTimersByTime(1_000)
  expect(clock.awakeNow() - start).toBe(3_500)
  clock.dispose()
})

/**
 * A clock whose host sleeps over `[from, until)`. Timers run on wall time, as on
 * macOS under Electron's node (its clock counts system sleep): a deadline that
 * falls inside the sleep fires the moment the host wakes.
 */
function sleepingClock(sleep: { from: number; until: number }) {
  const slept = (): number => Math.max(0, Math.min(Date.now(), sleep.until) - sleep.from)
  return () => ({
    lastResumeAt: () => (Date.now() >= sleep.until ? sleep.until : 0),
    awakeNow: () => Date.now() - slept(),
    dispose: () => undefined
  })
}

describe('awake timeouts', () => {
  test('fire after the window', () => {
    const timeouts = createAwakeTimeouts()
    const fn = vi.fn()
    timeouts.set(fn, 5_000)
    vi.advanceTimersByTime(4_999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('time asleep does not count: the rest of the window starts at wake', () => {
    const t0 = Date.now()
    const wake = t0 + 5_000 + 42 * 60_000
    const timeouts = createAwakeTimeouts({
      clock: sleepingClock({ from: t0 + 5_000, until: wake })
    })
    const fn = vi.fn()
    timeouts.set(fn, 30_000)
    vi.advanceTimersByTime(wake - t0)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(24_999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('cancel stops it', () => {
    const timeouts = createAwakeTimeouts()
    const fn = vi.fn()
    const cancel = timeouts.set(fn, 5_000)
    cancel()
    vi.advanceTimersByTime(10_000)
    expect(fn).not.toHaveBeenCalled()
  })

  test('the clock ticks only while a timeout is pending', () => {
    const timeouts = createAwakeTimeouts()
    expect(vi.getTimerCount()).toBe(0)
    const cancel = timeouts.set(() => undefined, 5_000)
    expect(vi.getTimerCount()).toBe(2) // the timeout + the clock's ticker
    cancel()
    expect(vi.getTimerCount()).toBe(0)
    timeouts.set(() => undefined, 5_000)
    vi.advanceTimersByTime(5_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})
