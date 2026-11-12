import { describe, expect, it } from 'vitest'
import {
  createSpawnAdmission,
  defaultAdmissionConcurrency,
  type AdmissionEvent,
  type AdmissionLane,
  type AdmissionSlot
} from './spawn-admission'

/** Manual clock + timers, so every ordering below is deterministic. */
function fakeTime() {
  let t = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++
      timers.set(id, { at: t + ms, fn })
      return id
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number)
    },
    advance(ms: number) {
      const until = t + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = due[1].at
        due[1].fn()
      }
      t = until
    }
  }
}

function harness(opts: { concurrency?: number; startCapMs?: number; warmQuietMs?: number } = {}) {
  const time = fakeTime()
  const events: AdmissionEvent[] = []
  const admission = createSpawnAdmission({
    concurrency: opts.concurrency ?? 2,
    startCapMs: opts.startCapMs ?? 5_000,
    warmQuietMs: opts.warmQuietMs ?? 3_000,
    onEvent: (e) => events.push(e),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer
  })
  const started: string[] = []
  const slots = new Map<string, AdmissionSlot>()
  const enqueue = (name: string, lane: AdmissionLane) =>
    admission.enqueue(lane, (slot) => {
      started.push(name)
      slots.set(name, slot)
    })
  return { time, admission, started, slots, enqueue, events }
}

describe('spawn admission', () => {
  // The record a slow restore is diagnosed from (computer.log): each start's wait
  // for its slot, how long it held it, and whether the agent or the cap freed it.
  it('reports each start: its wait, its hold, and what released it', () => {
    const h = harness({ concurrency: 1, startCapMs: 5_000 })
    h.enqueue('a', 'background')
    h.enqueue('b', 'background')
    h.time.advance(1_200)
    h.slots.get('a')!.release()
    h.time.advance(5_000)
    expect(h.events).toEqual([
      { type: 'admitted', lane: 'background', waitedMs: 0, queued: 0, active: 1 },
      { type: 'released', lane: 'background', heldMs: 1_200, by: 'agent' },
      { type: 'admitted', lane: 'background', waitedMs: 1_200, queued: 0, active: 1 },
      { type: 'released', lane: 'background', heldMs: 5_000, by: 'cap' }
    ])
  })

  it('a throwing listener never breaks a start', () => {
    const admission = createSpawnAdmission({
      concurrency: 1,
      onEvent: () => {
        throw new Error('log sink down')
      }
    })
    const started: string[] = []
    admission.enqueue('foreground', () => started.push('a'))
    expect(started).toEqual(['a'])
  })

  it('starts at most `concurrency` agents; the next one starts when a slot is released', () => {
    const h = harness({ concurrency: 2 })
    for (const n of ['a', 'b', 'c', 'd']) h.enqueue(n, 'background')
    expect(h.started).toEqual(['a', 'b'])
    expect(h.admission.stats()).toMatchObject({ queued: 2, active: 2 })

    h.slots.get('a')!.release() // a printed its first output
    expect(h.started).toEqual(['a', 'b', 'c'])
    h.slots.get('a')!.release() // idempotent — must not free a second slot
    expect(h.started).toEqual(['a', 'b', 'c'])
  })

  it('foreground goes before background; each lane is FIFO', () => {
    const h = harness({ concurrency: 1 })
    h.enqueue('first', 'background') // takes the only slot
    h.enqueue('bg1', 'background')
    h.enqueue('bg2', 'background')
    h.enqueue('fg1', 'foreground')
    h.enqueue('fg2', 'foreground')
    for (const n of ['first', 'fg1', 'fg2', 'bg1']) h.slots.get(n)!.release()
    expect(h.started).toEqual(['first', 'fg1', 'fg2', 'bg1', 'bg2'])
  })

  it('prioritize moves a queued start to the very front (latest reveal first)', () => {
    const h = harness({ concurrency: 1 })
    h.enqueue('running', 'background')
    h.enqueue('fg', 'foreground')
    const bg1 = h.enqueue('bg1', 'background')
    const bg2 = h.enqueue('bg2', 'background')
    expect(h.admission.prioritize(bg1)).toBe(true)
    expect(h.admission.prioritize(bg2)).toBe(true)
    for (const n of ['running', 'bg2', 'bg1']) h.slots.get(n)!.release()
    expect(h.started).toEqual(['running', 'bg2', 'bg1', 'fg'])
    // Already started: nothing to move.
    expect(h.admission.prioritize(bg1)).toBe(false)
  })

  it('a start that never prints frees its slot after the cap', () => {
    const h = harness({ concurrency: 1, startCapMs: 5_000 })
    h.enqueue('silent', 'background')
    h.enqueue('next', 'background')
    h.time.advance(4_999)
    expect(h.started).toEqual(['silent'])
    h.time.advance(1)
    expect(h.started).toEqual(['silent', 'next'])
  })

  it('cancel removes a queued start; it never runs', () => {
    const h = harness({ concurrency: 1 })
    h.enqueue('a', 'background')
    const b = h.enqueue('b', 'background')
    h.enqueue('c', 'background')
    expect(h.admission.cancel(b)).toBe(true)
    expect(h.admission.isQueued(b)).toBe(false)
    h.slots.get('a')!.release()
    expect(h.started).toEqual(['a', 'c'])
    expect(h.admission.cancel(b)).toBe(false)
  })

  it('a throwing start releases its slot', () => {
    const h = harness({ concurrency: 1 })
    h.admission.enqueue('background', () => {
      throw new Error('spawn failed')
    })
    h.enqueue('after', 'background')
    expect(h.started).toEqual(['after'])
  })

  describe('warm lane', () => {
    it('waits while any agent start is queued or in flight, then for the quiet period', () => {
      const h = harness({ concurrency: 4, warmQuietMs: 3_000 })
      h.enqueue('agent', 'background')
      h.enqueue('warm1', 'warm')
      // Free slots exist, but an agent is starting: the pool must not compete.
      expect(h.started).toEqual(['agent'])
      h.time.advance(1_000)
      h.slots.get('agent')!.release()
      expect(h.started).toEqual(['agent'])
      h.time.advance(2_999)
      expect(h.started).toEqual(['agent'])
      h.time.advance(1)
      expect(h.started).toEqual(['agent', 'warm1'])
    })

    it('a later agent start still goes before queued warm starts', () => {
      const h = harness({ concurrency: 1, warmQuietMs: 0 })
      h.enqueue('agent1', 'background')
      h.enqueue('warm1', 'warm')
      h.enqueue('agent2', 'foreground')
      h.slots.get('agent1')!.release()
      expect(h.started).toEqual(['agent1', 'agent2'])
      h.slots.get('agent2')!.release()
      expect(h.started).toEqual(['agent1', 'agent2', 'warm1'])
    })

    it('boots one warm agent at a time', () => {
      const h = harness({ concurrency: 4, warmQuietMs: 0 })
      h.enqueue('w1', 'warm')
      h.enqueue('w2', 'warm')
      expect(h.started).toEqual(['w1'])
      h.slots.get('w1')!.release()
      expect(h.started).toEqual(['w1', 'w2'])
    })

    it('starts at once on an idle computer', () => {
      const h = harness({ warmQuietMs: 3_000 })
      h.enqueue('w', 'warm')
      expect(h.started).toEqual(['w'])
    })
  })

  it('default concurrency is half the cores, clamped to 2..4', () => {
    expect(defaultAdmissionConcurrency(1)).toBe(2)
    expect(defaultAdmissionConcurrency(6)).toBe(3)
    expect(defaultAdmissionConcurrency(10)).toBe(4)
    expect(defaultAdmissionConcurrency(64)).toBe(4)
  })
})
