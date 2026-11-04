/**
 * The suspend clock: when this process last came back from a freeze (host sleep,
 * VM suspend, a stopped debugger) — the window a watchdog must not judge.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createSuspendClock } from './host-suspend-clock'

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
