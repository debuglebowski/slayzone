/**
 * The `/trpc` socket registry's IdP-role deadline (trpc-connections.ts `setDeadline`):
 * at an account's persisted evidence deadline its sockets close SYNCHRONOUSLY — with a
 * revalidation held unresolved, nothing runs between the deadline and the close — unless
 * the deadline already moved forward (the sweep re-proved the account ahead of time).
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { expect, test } from 'vitest'
import {
  createTrpcConnectionRegistry,
  SESSION_ENDED_CLOSE_CODE,
  type TrackedSocket
} from './trpc-connections.js'

function fakeClock() {
  let now = 1_000_000
  const timeouts: Array<{ at: number; fn: () => void; cleared: boolean }> = []
  return {
    timers: {
      setInterval: () => ({}),
      clearInterval: () => undefined,
      setTimeout: (fn: () => void, ms: number) => {
        const t = { at: now + ms, fn, cleared: false }
        timeouts.push(t)
        return t
      },
      clearTimeout: (h: unknown) => {
        ;(h as { cleared: boolean }).cleared = true
      },
      now: () => now
    },
    /** Move the clock to `at` and fire every due timer, in order. */
    advanceTo(at: number) {
      now = at
      for (const t of [...timeouts].sort((a, b) => a.at - b.at)) {
        if (!t.cleared && t.at <= now) {
          t.cleared = true
          t.fn()
        }
      }
    },
    get now() {
      return now
    }
  }
}

function socket() {
  const closes: Array<[number | undefined, string | undefined]> = []
  const s: TrackedSocket & { closes: typeof closes; open: boolean } = {
    readyState: 1,
    closes,
    open: true,
    close(code, reason) {
      closes.push([code, reason])
      s.open = false
    },
    once: () => undefined
  }
  return s
}

test('at the exact deadline the socket closes synchronously — no revalidation is awaited, none even started', () => {
  const clock = fakeClock()
  const registry = createTrpcConnectionRegistry({ timers: clock.timers })
  let revalidations = 0
  const held = new Promise<string | null>(() => undefined) // a refresh that never answers
  const s = socket()
  const deadline = clock.now + 3_600_000
  registry.setDeadline(() => deadline)
  registry.track(s, 'u1', () => {
    revalidations++
    return held
  })
  clock.advanceTo(deadline - 1)
  expect(s.open).toBe(true)
  clock.advanceTo(deadline)
  // Synchronously inside the timer callback: closed, and nothing awaited first.
  expect(s.open).toBe(false)
  expect(s.closes).toEqual([[SESSION_ENDED_CLOSE_CODE, 'role evidence expired']])
  expect(revalidations).toBe(0)
  expect(registry.count('u1')).toBe(0)
})

test('re-proven before the deadline (a later persisted deadline): kept and re-armed, closed at the new one', () => {
  const clock = fakeClock()
  const registry = createTrpcConnectionRegistry({ timers: clock.timers })
  const s = socket()
  let deadline = clock.now + 3_600_000
  registry.setDeadline(() => deadline)
  registry.track(s, 'u1', async () => 'u1')
  // The sweep refreshed the account 5 minutes ahead: the persisted deadline moved.
  deadline += 3_600_000
  clock.advanceTo(clock.now + 3_600_000)
  expect(s.open).toBe(true)
  clock.advanceTo(deadline)
  expect(s.open).toBe(false)
})

test('no evidence (deadline 0) or an unreadable deadline: closed at once', () => {
  const clock = fakeClock()
  const registry = createTrpcConnectionRegistry({ timers: clock.timers })
  const a = socket()
  const b = socket()
  registry.setDeadline((userId) => {
    if (userId === 'boom') throw new Error('db')
    return 0
  })
  registry.track(a, 'none', async () => 'none')
  registry.track(b, 'boom', async () => 'boom')
  clock.advanceTo(clock.now)
  expect(a.open).toBe(false)
  expect(b.open).toBe(false)
})

test('without setDeadline (mode off) no deadline timer exists: unchanged behaviour', () => {
  const clock = fakeClock()
  const registry = createTrpcConnectionRegistry({ timers: clock.timers })
  const s = socket()
  registry.track(s, 'u1', async () => 'u1')
  clock.advanceTo(clock.now + 10 * 3_600_000)
  expect(s.open).toBe(true)
})
