/**
 * How the hub process ends. A planned restart must end as exit 75 WHATEVER way the
 * process ends: a clean stop, the deadline, or the event loop simply draining (both
 * deadline timers are unref'd) — under systemd `Restart=on-failure` / launchd
 * `SuccessfulExit=false`, a 0 would leave a server hub down with the restore pending.
 */
import { describe, expect, test, vi } from 'vitest'
import { createShutdown } from './hub-shutdown.js'

function fakeProc() {
  return { exitCode: undefined as number | undefined, exit: vi.fn() }
}

describe('createShutdown', () => {
  test('L3: a restart sets exitCode 75 at once, before the stop even finishes', async () => {
    const proc = fakeProc()
    let finish!: () => void
    const shutdown = createShutdown({
      stop: () => new Promise<void>((r) => (finish = r)),
      supervised: false,
      proc,
      log: () => {}
    })
    const done = shutdown('restart (restore)', 75)
    expect(proc.exitCode, 'a drained loop would exit 75 too').toBe(75)
    finish()
    await done
    expect(proc.exit).toHaveBeenCalledWith(75)
  })

  test('a plain stop exits 0; a failing stop exits 1', async () => {
    const ok = fakeProc()
    await createShutdown({ stop: async () => {}, supervised: false, proc: ok, log: () => {} })(
      'SIGTERM'
    )
    expect(ok.exit).toHaveBeenCalledWith(0)
    const bad = fakeProc()
    await createShutdown({
      stop: async () => {
        throw new Error('boom')
      },
      supervised: false,
      proc: bad,
      log: () => {}
    })('SIGTERM')
    expect(bad.exit).toHaveBeenCalledWith(1)
  })

  test('a restart that hangs exits 75 at the deadline, on every hub', async () => {
    vi.useFakeTimers()
    try {
      const proc = fakeProc()
      void createShutdown({
        stop: () => new Promise<void>(() => {}),
        supervised: false,
        proc,
        log: () => {},
        deadlineMs: 1_000
      })('restart (restore)', 75)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(proc.exit).toHaveBeenCalledWith(75)
    } finally {
      vi.useRealTimers()
    }
  })

  test('only the first call counts', async () => {
    const proc = fakeProc()
    const stop = vi.fn(async () => {})
    const shutdown = createShutdown({ stop, supervised: false, proc, log: () => {} })
    await Promise.all([shutdown('SIGTERM'), shutdown('restart', 75)])
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
