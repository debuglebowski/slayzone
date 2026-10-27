/**
 * A window's warm-pool tab counts are dropped when its last `/trpc` socket to this hub
 * closes and stays closed.
 *
 * The counts are what keep a project's warm agent alive (one per project with an open
 * task tab), and only the window that reported them can retract them. A window that
 * closes never sends an empty report, so without this its last snapshot kept warm
 * agents (billable) running with no tab to use them.
 *
 * Pure (fake sockets, fake timers).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/warm-window-sockets.test.ts
 */
import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import { createWarmWindowSockets } from './warm-window-sockets.js'

class FakeSocket extends EventEmitter {
  close(): void {
    this.emit('close')
  }
}

/** Timers driven by hand: `advance(ms)` fires everything due. */
function fakeTimers() {
  let now = 0
  let next = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++
        pending.set(id, { at: now + ms, fn })
        return id
      },
      clearTimeout: (id: unknown) => {
        pending.delete(id as number)
      }
    },
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id)
          t.fn()
        }
      }
    }
  }
}

function setup() {
  const cleared: number[] = []
  const t = fakeTimers()
  const sockets = createWarmWindowSockets({
    clearWindow: (id) => cleared.push(id),
    graceMs: 10_000,
    timers: t.timers
  })
  return { cleared, t, sockets }
}

test('a window whose socket closes for good loses its counts after the grace', () => {
  const { cleared, t, sockets } = setup()
  const s = new FakeSocket()
  sockets.track(7, s)
  s.close()
  t.advance(9_999)
  expect(cleared, 'not before the grace').toEqual([])
  t.advance(1)
  expect(cleared, 'cleared once the grace runs out').toEqual([7])
})

test('a reload or reconnect within the grace keeps the counts', () => {
  const { cleared, t, sockets } = setup()
  const a = new FakeSocket()
  sockets.track(7, a)
  a.close()
  t.advance(2_000)
  sockets.track(7, new FakeSocket())
  t.advance(60_000)
  expect(cleared, 'the window came back').toEqual([])
})

test('only the last open socket of a window counts', () => {
  const { cleared, t, sockets } = setup()
  const a = new FakeSocket()
  const b = new FakeSocket()
  sockets.track(7, a)
  sockets.track(7, b)
  a.close()
  t.advance(60_000)
  expect(cleared, 'one socket still open').toEqual([])
  b.close()
  t.advance(10_000)
  expect(cleared, 'cleared after the last one').toEqual([7])
})

test('windows are independent', () => {
  const { cleared, t, sockets } = setup()
  const a = new FakeSocket()
  sockets.track(1, a)
  sockets.track(2, new FakeSocket())
  a.close()
  t.advance(10_000)
  expect(cleared, 'only the closed window').toEqual([1])
})

test('a socket that closes twice is counted once', () => {
  const { cleared, t, sockets } = setup()
  const a = new FakeSocket()
  const b = new FakeSocket()
  sockets.track(7, a)
  sockets.track(7, b)
  a.close()
  a.close()
  t.advance(10_000)
  expect(cleared, 'b is still open').toEqual([])
})
