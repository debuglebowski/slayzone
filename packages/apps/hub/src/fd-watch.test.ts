/**
 * The hub's open-file watchdog (fd-watch.ts): a leak is reported long before the hub
 * runs out of descriptors and every spawn fails. One warning per doubling past the
 * threshold (not one per tick), re-armed once the count falls back.
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/apps/hub/src/fd-watch.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { DiagnosticEvent } from '@slayzone/diagnostics/shared'
import { FD_WARN_THRESHOLD, countOpenFds, startFdWatch } from './fd-watch'

function harness(counts: Array<number | null>) {
  const events: DiagnosticEvent[] = []
  let tick: (() => void) | null = null
  let cleared = false
  const handle = startFdWatch({
    countFds: () => counts.shift() ?? null,
    record: (e) => events.push(e),
    timers: {
      setInterval: (fn) => {
        tick = fn
        return 1
      },
      clearInterval: () => {
        cleared = true
      }
    }
  })
  return { events, tick: () => tick?.(), handle, wasCleared: () => cleared }
}

describe('startFdWatch', () => {
  it('warns once when crossing the threshold, then once per doubling', () => {
    const T = FD_WARN_THRESHOLD
    const h = harness([10, T + 1, T + 5, 2 * T + 1, 2 * T + 2, 4 * T])
    for (let i = 0; i < 6; i++) h.tick()
    expect(h.events.map((e) => (e.payload as { openFds: number }).openFds)).toEqual([
      T + 1,
      2 * T + 1,
      4 * T
    ])
    expect(h.events.every((e) => e.level === 'warn' && e.event === 'server.fd_high')).toBe(true)
  })

  it('re-arms after the count falls below the threshold', () => {
    const T = FD_WARN_THRESHOLD
    const h = harness([T + 1, 50, T + 2])
    for (let i = 0; i < 3; i++) h.tick()
    expect(h.events.map((e) => (e.payload as { openFds: number }).openFds)).toEqual([T + 1, T + 2])
  })

  it('creates no timer where fds cannot be counted', () => {
    const h = harness([null])
    expect(h.handle.active).toBe(false)
  })

  it('stop clears the timer', () => {
    const h = harness([1, 1])
    h.handle.stop()
    expect(h.wasCleared()).toBe(true)
  })
})

describe('countOpenFds', () => {
  it.skipIf(process.platform === 'win32')('counts this process’s descriptors', () => {
    const n = countOpenFds()
    expect(n).toBeGreaterThan(2) // stdin/stdout/stderr at least
  })
})
