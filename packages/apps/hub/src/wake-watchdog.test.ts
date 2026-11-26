import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startWakeWatchdog } from './wake-watchdog'

// The hub notices its own machine woke from sleep (D4, task 557ebb72): a timer that
// should tick every `intervalMs` sees the wall clock jump by far more than that.
// Replaces the desktop forwarding Electron's `powerMonitor 'resume'` over the bridge,
// which a standalone hub (no desktop) never got.

let now = 0
beforeEach(() => {
  vi.useFakeTimers()
  now = 1_000_000
})
afterEach(() => vi.useRealTimers())

const start = (onWake: () => void) =>
  startWakeWatchdog({ onWake, intervalMs: 10_000, slackMs: 20_000, now: () => now })

const tick = (wallMs: number) => {
  now += wallMs
  vi.advanceTimersByTime(10_000)
}

test('regular ticks are not a wake', () => {
  const onWake = vi.fn()
  const stop = start(onWake)
  for (let i = 0; i < 20; i++) tick(10_000)
  // a slow tick within the slack (busy event loop) is not one either
  tick(25_000)
  expect(onWake).not.toHaveBeenCalled()
  stop()
})

test('a wall-clock jump past interval + slack fires once', () => {
  const onWake = vi.fn()
  const stop = start(onWake)
  tick(10_000)
  tick(60 * 60_000) // an hour asleep
  expect(onWake).toHaveBeenCalledTimes(1)
  tick(10_000)
  expect(onWake).toHaveBeenCalledTimes(1)
  stop()
})

test('a thrown handler does not stop the watchdog', () => {
  const onWake = vi.fn(() => {
    throw new Error('catchup failed')
  })
  const stop = start(onWake)
  tick(120_000)
  tick(120_000)
  expect(onWake).toHaveBeenCalledTimes(2)
  stop()
})

test('stop clears the timer', () => {
  const onWake = vi.fn()
  start(onWake)()
  tick(120_000)
  expect(onWake).not.toHaveBeenCalled()
})
