/**
 * Boot-time terminal init queue (terminal-init-scheduler.ts) + the one-round-trip
 * PTY attach (pty-attach.ts).
 */
import { describe, expect, test } from 'vitest'
import { createInitScheduler, MAX_HOLD_MS, type InitSlot } from './terminal-init-scheduler'
import {
  __resetPtyAttachForTest,
  attachPty,
  markSessionUnspawned,
  isSessionKnownUnspawned,
  UNSPAWNED_MARK_TTL_MS,
  type PtyAttachClient
} from './pty-attach'

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
    expect(cb, 'an idle callback was scheduled').toBeDefined()
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

describe('init scheduler', () => {
  test('on-screen terminal is granted at once, without an idle wait', async () => {
    const h = harness()
    await h.request('visible', true)
    expect(h.granted.join(), 'granted immediately').toBe('visible')
    expect(h.idle, 'took no turn').toHaveLength(0)
  })

  test('hidden terminals take turns: one per idle slice, next only after release', async () => {
    const h = harness()
    void h.request('a')
    void h.request('b')
    await tick()
    expect(h.granted, 'nothing before idle').toHaveLength(0)
    await h.runIdle()
    expect(h.granted.join(), 'first granted').toBe('a')
    expect(h.idle, 'no next idle while a holds the slot').toHaveLength(0)
    h.slots.get('a')!.release()
    await h.runIdle()
    expect(h.granted.join(), 'second after release').toBe('a,b')
  })

  test('queued terminals go in MRU order', async () => {
    const h = harness({ c: 0, a: 2, b: 1 })
    for (const sid of ['a', 'b', 'c']) void h.request(sid)
    await h.runIdle()
    h.slots.get(h.granted[0])!.release()
    await h.runIdle()
    h.slots.get(h.granted[1])!.release()
    await h.runIdle()
    expect(h.granted.join(), `order ${h.granted}`).toBe('c,b,a')
  })

  test('room left in the idle period: next granted in the same period', async () => {
    const h = harness()
    void h.request('a')
    void h.request('b')
    await h.runIdle(40)
    h.slots.get('a')!.release()
    await tick()
    expect(h.granted.join(), 'b granted in the same idle period').toBe('a,b')
  })

  test('reveal promotes a queued terminal past the queue', async () => {
    const h = harness()
    void h.request('a')
    void h.request('b')
    await h.runIdle()
    expect(h.s.promote('b'), 'promoted').toBe(true)
    await tick()
    expect(h.granted.join(), 'b runs while a still holds the slot').toBe('a,b')
    expect(h.s.isQueued('b'), 'no longer queued').toBe(false)
    expect(h.s.promote('b'), 'second promote is a no-op').toBe(false)
  })

  test('a stuck holder is released after MAX_HOLD_MS', async () => {
    const h = harness()
    void h.request('a')
    void h.request('b')
    await h.runIdle()
    expect(MAX_HOLD_MS, 'hold cap set').toBeGreaterThan(0)
    h.fireTimers() // the hold timer for 'a'
    await h.runIdle()
    expect(h.granted.join(), 'queue moved on').toBe('a,b')
  })

  test('abort while queued resolves with a no-op slot and leaves the queue', async () => {
    const h = harness()
    const ac = new AbortController()
    const p = h.request('a', false, ac.signal)
    ac.abort()
    await p
    expect(h.s.isQueued('a'), 'removed').toBe(false)
    h.slots.get('a')!.release() // no-op slot: must not disturb accounting
    void h.request('b')
    await h.runIdle()
    expect(h.granted.at(-1), 'queue still works').toBe('b')
  })

})

describe('pty attach', () => {
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

  test('one round trip when the server has pty.attach', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => ({
      exists: true,
      state: 'running',
      buffer: { chunks: [], currentSeq: 3 }
    }))
    const r = await attachPty(client, 's', -1)
    expect(calls.join(), `calls ${calls}`).toBe('attach')
    expect(r.exists, 'result passed through').toBe(true)
    expect(r.state, 'result passed through').toBe('running')
    expect(r.buffer?.currentSeq, 'result passed through').toBe(3)
  })

  test('older server without pty.attach: falls back to the three calls, once', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => {
      throw Object.assign(new Error('No "query"-procedure on path "pty.attach"'), {
        data: { code: 'NOT_FOUND' }
      })
    })
    const r = await attachPty(client, 's', -1)
    expect(r.exists, 'legacy result').toBe(true)
    expect(r.state, 'legacy result').toBe('running')
    expect(r.buffer?.currentSeq, 'legacy result').toBe(1)
    await attachPty(client, 's', 1)
    expect(calls.join(), `calls ${calls}`).toBe(
      'attach,exists,getState,getBufferSince,exists,getState,getBufferSince'
    )
  })

  test('other attach errors propagate (no silent fallback)', async () => {
    __resetPtyAttachForTest()
    const { client } = fakeClient(async () => {
      throw new Error('network down')
    })
    await expect(attachPty(client, 's', -1), 'rejected').rejects.toThrow('network down')
  })

  test('session marked unspawned: first attach skips the round trip, once', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => ({
      exists: true,
      state: 'running',
      buffer: { chunks: [], currentSeq: 3 }
    }))
    markSessionUnspawned('fresh')
    const first = await attachPty(client, 'fresh', -1)
    expect(calls, `no round trip for a just-created session (calls ${calls})`).toHaveLength(0)
    expect(first.exists, 'reports absent').toBe(false)
    expect(first.state, 'reports absent').toBeNull()
    expect(first.buffer, 'reports absent').toBeNull()
    // One-shot: a remount (hibernate wake, re-init) must ask the server again.
    await attachPty(client, 'fresh', -1)
    expect(calls.join(), `second attach asks the server (calls ${calls})`).toBe('attach')
    // Scoped to its own session id.
    markSessionUnspawned('a')
    await attachPty(client, 'b', -1)
    expect(calls.join(), `other sessions unaffected (calls ${calls})`).toBe('attach,attach')
  })

  test('isSessionKnownUnspawned peeks without consuming the mark', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => ({
      exists: true,
      state: 'running',
      buffer: { chunks: [], currentSeq: 3 }
    }))
    expect(isSessionKnownUnspawned('p'), 'unmarked → unknown').toBe(false)
    markSessionUnspawned('p')
    expect(isSessionKnownUnspawned('p'), 'marked → known').toBe(true)
    expect(isSessionKnownUnspawned('p'), 'peek again → still known').toBe(true)
    await attachPty(client, 'p', -1)
    expect(calls, 'attach still consumes the mark without a round trip').toHaveLength(0)
    expect(isSessionKnownUnspawned('p'), 'consumed by attach').toBe(false)
    markSessionUnspawned('q', Date.now() - UNSPAWNED_MARK_TTL_MS - 1)
    expect(isSessionKnownUnspawned('q'), 'expired → unknown').toBe(false)
  })

  test('unspawned mark expires: a stale mark never hides a live session', async () => {
    __resetPtyAttachForTest()
    const { client, calls } = fakeClient(async () => ({
      exists: true,
      state: 'running',
      buffer: { chunks: [], currentSeq: 3 }
    }))
    markSessionUnspawned('old', Date.now() - UNSPAWNED_MARK_TTL_MS - 1)
    const r = await attachPty(client, 'old', -1)
    expect(calls.join(), `expired mark ignored (calls ${calls})`).toBe('attach')
    expect(r.exists, `expired mark ignored (calls ${calls})`).toBe(true)
  })
})
