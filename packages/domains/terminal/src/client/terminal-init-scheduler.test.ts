/**
 * Boot-time terminal init queue (terminal-init-scheduler.ts) + the one-round-trip
 * PTY attach (pty-attach.ts).
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/terminal-init-scheduler.test.ts
 */
import { createInitScheduler, MAX_HOLD_MS, type InitSlot } from './terminal-init-scheduler'
import {
  __resetPtyAttachForTest,
  attachPty,
  markSessionUnspawned,
  isSessionKnownUnspawned,
  UNSPAWNED_MARK_TTL_MS,
  type PtyAttachClient
} from './pty-attach'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Scheduler with a manual idle queue + manual timers. */
function harness(rank: Record<string, number> = {}) {
  const idle: Array<(d: { didTimeout: boolean; timeRemaining: () => number }) => void> = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  let remaining = 0
  const s = createInitScheduler({
    requestIdle: (cb) => idle.push(cb),
    setTimer: (cb) => {
      const id = nextTimer++
      timers.set(id, cb)
      return id
    },
    clearTimer: (id) => timers.delete(id as number),
    rank: (sid) => rank[sid] ?? Number.MAX_SAFE_INTEGER
  })
  const granted: string[] = []
  const slots = new Map<string, InitSlot>()
  const request = (sid: string, immediate = false, signal = new AbortController().signal) =>
    s.acquire(sid, { immediate, signal }).then((slot) => {
      granted.push(sid)
      slots.set(sid, slot)
    })
  const runIdle = async (timeRemaining = 0): Promise<void> => {
    remaining = timeRemaining
    const cb = idle.shift()
    ok(!!cb, 'an idle callback was scheduled')
    cb!({ didTimeout: remaining === 0, timeRemaining: () => remaining })
    await tick()
  }
  const fireTimers = (): void => {
    for (const [id, cb] of [...timers]) {
      timers.delete(id)
      cb()
    }
  }
  return { s, granted, slots, request, runIdle, idle, fireTimers }
}

async function run(): Promise<void> {
  console.log('\ninit scheduler')
  console.log('─'.repeat(40))

  await test('on-screen terminal is granted at once, without an idle wait', async () => {
    const h = harness()
    await h.request('visible', true)
    ok(h.granted.join() === 'visible', 'granted immediately')
    ok(h.idle.length === 0, 'took no turn')
  })

  await test('hidden terminals take turns: one per idle slice, next only after release', async () => {
    const h = harness()
    void h.request('a')
    void h.request('b')
    await tick()
    ok(h.granted.length === 0, 'nothing before idle')
    await h.runIdle()
    ok(h.granted.join() === 'a', 'first granted')
    ok(h.idle.length === 0, 'no next idle while a holds the slot')
    h.slots.get('a')!.release()
    await h.runIdle()
    ok(h.granted.join() === 'a,b', 'second after release')
  })

  await test('queued terminals go in MRU order', async () => {
    const h = harness({ c: 0, a: 2, b: 1 })
    for (const sid of ['a', 'b', 'c']) void h.request(sid)
    await h.runIdle()
    h.slots.get(h.granted[0])!.release()
    await h.runIdle()
    h.slots.get(h.granted[1])!.release()
    await h.runIdle()
    ok(h.granted.join() === 'c,b,a', `order ${h.granted}`)
  })

  await test('room left in the idle period: next granted in the same period', async () => {
    const h = harness()
    void h.request('a')
    void h.request('b')
    await h.runIdle(40)
    h.slots.get('a')!.release()
    await tick()
    ok(h.granted.join() === 'a,b', 'b granted in the same idle period')
  })

  await test('reveal promotes a queued terminal past the queue', async () => {
    const h = harness()
    void h.request('a')
    void h.request('b')
    await h.runIdle()
    ok(h.s.promote('b'), 'promoted')
    await tick()
    ok(h.granted.join() === 'a,b', 'b runs while a still holds the slot')
    ok(!h.s.isQueued('b'), 'no longer queued')
    ok(!h.s.promote('b'), 'second promote is a no-op')
  })

  await test('a stuck holder is released after MAX_HOLD_MS', async () => {
    const h = harness()
    void h.request('a')
    void h.request('b')
    await h.runIdle()
    ok(MAX_HOLD_MS > 0, 'hold cap set')
    h.fireTimers() // the hold timer for 'a'
    await h.runIdle()
    ok(h.granted.join() === 'a,b', 'queue moved on')
  })

  await test('abort while queued resolves with a no-op slot and leaves the queue', async () => {
    const h = harness()
    const ac = new AbortController()
    const p = h.request('a', false, ac.signal)
    ac.abort()
    await p
    ok(!h.s.isQueued('a'), 'removed')
    h.slots.get('a')!.release() // no-op slot: must not disturb accounting
    void h.request('b')
    await h.runIdle()
    ok(h.granted.at(-1) === 'b', 'queue still works')
  })

  console.log('\npty attach')
  console.log('─'.repeat(40))

  const fakeClient = (attach: () => Promise<unknown>) => {
    const calls: string[] = []
    const client = {
      pty: {
        attach: {
          query: async () => {
            calls.push('attach')
            return attach()
          }
        },
        exists: {
          query: async () => {
            calls.push('exists')
            return true
          }
        },
        getState: {
          query: async () => {
            calls.push('getState')
            return 'running'
          }
        },
        getBufferSince: {
          query: async () => {
            calls.push('getBufferSince')
            return { chunks: [{ seq: 1, data: 'x' }], currentSeq: 1 }
          }
        }
      }
    } as unknown as PtyAttachClient
    return { client, calls }
  }

  await test('one round trip when the server has pty.attach', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => ({
      exists: true,
      state: 'running',
      buffer: { chunks: [], currentSeq: 3 }
    }))
    const r = await attachPty(client, 's', -1)
    ok(calls.join() === 'attach', `calls ${calls}`)
    ok(r.exists && r.state === 'running' && r.buffer?.currentSeq === 3, 'result passed through')
  })

  await test('older server without pty.attach: falls back to the three calls, once', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => {
      throw Object.assign(new Error('No "query"-procedure on path "pty.attach"'), {
        data: { code: 'NOT_FOUND' }
      })
    })
    const r = await attachPty(client, 's', -1)
    ok(r.exists && r.state === 'running' && r.buffer?.currentSeq === 1, 'legacy result')
    await attachPty(client, 's', 1)
    ok(
      calls.join() === 'attach,exists,getState,getBufferSince,exists,getState,getBufferSince',
      `calls ${calls}`
    )
  })

  await test('other attach errors propagate (no silent fallback)', async () => {
    __resetPtyAttachForTest()
    const { client } = fakeClient(async () => {
      throw new Error('network down')
    })
    let threw = false
    await attachPty(client, 's', -1).catch(() => (threw = true))
    ok(threw, 'rejected')
  })

  await test('session marked unspawned: first attach skips the round trip, once', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => ({
      exists: true,
      state: 'running',
      buffer: { chunks: [], currentSeq: 3 }
    }))
    markSessionUnspawned('fresh')
    const first = await attachPty(client, 'fresh', -1)
    ok(calls.length === 0, `no round trip for a just-created session (calls ${calls})`)
    ok(!first.exists && first.state === null && first.buffer === null, 'reports absent')
    // One-shot: a remount (hibernate wake, re-init) must ask the server again.
    await attachPty(client, 'fresh', -1)
    ok(calls.join() === 'attach', `second attach asks the server (calls ${calls})`)
    // Scoped to its own session id.
    markSessionUnspawned('a')
    await attachPty(client, 'b', -1)
    ok(calls.join() === 'attach,attach', `other sessions unaffected (calls ${calls})`)
  })

  await test('isSessionKnownUnspawned peeks without consuming the mark', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => ({
      exists: true,
      state: 'running',
      buffer: { chunks: [], currentSeq: 3 }
    }))
    ok(!isSessionKnownUnspawned('p'), 'unmarked → unknown')
    markSessionUnspawned('p')
    ok(isSessionKnownUnspawned('p'), 'marked → known')
    ok(isSessionKnownUnspawned('p'), 'peek again → still known')
    await attachPty(client, 'p', -1)
    ok(calls.length === 0, 'attach still consumes the mark without a round trip')
    ok(!isSessionKnownUnspawned('p'), 'consumed by attach')
    markSessionUnspawned('q', Date.now() - UNSPAWNED_MARK_TTL_MS - 1)
    ok(!isSessionKnownUnspawned('q'), 'expired → unknown')
  })

  await test('unspawned mark expires: a stale mark never hides a live session', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => ({
      exists: true,
      state: 'running',
      buffer: { chunks: [], currentSeq: 3 }
    }))
    markSessionUnspawned('old', Date.now() - UNSPAWNED_MARK_TTL_MS - 1)
    const r = await attachPty(client, 'old', -1)
    ok(calls.join() === 'attach' && r.exists, `expired mark ignored (calls ${calls})`)
  })

  console.log('\n' + '─'.repeat(40))
  console.log(`${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

void run()
