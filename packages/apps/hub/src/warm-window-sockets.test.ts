/**
 * A window's warm-pool tab counts are dropped when its last `/trpc` socket to this hub
 * closes and stays closed.
 *
 * The counts are what keep a project's warm agent alive (one per project with an open
 * task tab), and only the window that reported them can retract them. A window that
 * closes never sends an empty report, so without this its last snapshot kept warm
 * agents (billable) running with no tab to use them.
 *
 * Pure (fake sockets, fake timers) → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/apps/hub/src/warm-window-sockets.test.ts
 */
import { EventEmitter } from 'node:events'
import { createWarmWindowSockets } from './warm-window-sockets.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

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
  assertEq(cleared, [], 'not before the grace')
  t.advance(1)
  assertEq(cleared, [7], 'cleared once the grace runs out')
})

test('a reload or reconnect within the grace keeps the counts', () => {
  const { cleared, t, sockets } = setup()
  const a = new FakeSocket()
  sockets.track(7, a)
  a.close()
  t.advance(2_000)
  sockets.track(7, new FakeSocket())
  t.advance(60_000)
  assertEq(cleared, [], 'the window came back')
})

test('only the last open socket of a window counts', () => {
  const { cleared, t, sockets } = setup()
  const a = new FakeSocket()
  const b = new FakeSocket()
  sockets.track(7, a)
  sockets.track(7, b)
  a.close()
  t.advance(60_000)
  assertEq(cleared, [], 'one socket still open')
  b.close()
  t.advance(10_000)
  assertEq(cleared, [7], 'cleared after the last one')
})

test('windows are independent', () => {
  const { cleared, t, sockets } = setup()
  const a = new FakeSocket()
  sockets.track(1, a)
  sockets.track(2, new FakeSocket())
  a.close()
  t.advance(10_000)
  assertEq(cleared, [1], 'only the closed window')
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
  assertEq(cleared, [], 'b is still open')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
