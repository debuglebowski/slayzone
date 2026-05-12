import { describe, it, expect, vi } from 'vitest'
import { withResultDedup, isIpcUnchangedSentinel, type SenderLifecycle } from './ipc-dedup'

interface FakeEvent { senderId: number }

function makeLifecycle(): { lifecycle: SenderLifecycle<FakeEvent>; fire: (id: number) => void } {
  const clears = new Map<number, Array<() => void>>()
  return {
    lifecycle: {
      getKey: (e) => e.senderId,
      subscribe: (e, onClear) => {
        const list = clears.get(e.senderId) ?? []
        list.push(onClear)
        clears.set(e.senderId, list)
      }
    },
    fire: (id) => {
      const list = clears.get(id) ?? []
      list.forEach(fn => fn())
      clears.delete(id)
    }
  }
}

describe('withResultDedup — global cache (no sender)', () => {
  it('returns result on first call, sentinel on identical second call', async () => {
    const handler = vi.fn(async (_e: FakeEvent, x: number) => ({ x }))
    const wrapped = withResultDedup(handler)
    const first = await wrapped({ senderId: 1 }, 7)
    expect(first).toEqual({ x: 7 })
    const second = await wrapped({ senderId: 1 }, 7)
    expect(isIpcUnchangedSentinel(second)).toBe(true)
  })

  it('returns new result when args differ', async () => {
    const wrapped = withResultDedup(async (_e: FakeEvent, x: number) => ({ x }))
    expect(await wrapped({ senderId: 1 }, 1)).toEqual({ x: 1 })
    expect(await wrapped({ senderId: 1 }, 2)).toEqual({ x: 2 })
  })
})

describe('withResultDedup — sender-scoped cache', () => {
  it('clears cache when lifecycle fires — re-returns real result instead of stale sentinel', async () => {
    const { lifecycle, fire } = makeLifecycle()
    const wrapped = withResultDedup(async (_e: FakeEvent, x: number) => ({ x }), { sender: lifecycle })

    const first = await wrapped({ senderId: 1 }, 7)
    expect(first).toEqual({ x: 7 })
    const second = await wrapped({ senderId: 1 }, 7)
    expect(isIpcUnchangedSentinel(second)).toBe(true)

    fire(1)

    // Renderer reload wiped preload's cache. Main must NOT return UNCHANGED
    // here or the preload would surface `undefined` to its caller.
    const afterReload = await wrapped({ senderId: 1 }, 7)
    expect(afterReload).toEqual({ x: 7 })
    expect(isIpcUnchangedSentinel(afterReload)).toBe(false)
  })

  it('isolates caches between distinct senders', async () => {
    const { lifecycle } = makeLifecycle()
    const wrapped = withResultDedup(async (_e: FakeEvent, x: number) => ({ x }), { sender: lifecycle })

    expect(await wrapped({ senderId: 1 }, 7)).toEqual({ x: 7 })
    const sender2First = await wrapped({ senderId: 2 }, 7)
    expect(sender2First).toEqual({ x: 7 })
    expect(isIpcUnchangedSentinel(sender2First)).toBe(false)
  })

  it('registers lifecycle subscriber only once per sender', async () => {
    const subscribe = vi.fn<SenderLifecycle<FakeEvent>['subscribe']>()
    const lifecycle: SenderLifecycle<FakeEvent> = {
      getKey: (e) => e.senderId,
      subscribe
    }
    const wrapped = withResultDedup(async (_e: FakeEvent, x: number) => ({ x }), { sender: lifecycle })

    await wrapped({ senderId: 1 }, 1)
    await wrapped({ senderId: 1 }, 2)
    await wrapped({ senderId: 1 }, 3)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('bypasses dedup when getKey returns null', async () => {
    const lifecycle: SenderLifecycle<FakeEvent> = {
      getKey: () => null,
      subscribe: () => {}
    }
    const wrapped = withResultDedup(async (_e: FakeEvent, x: number) => ({ x }), { sender: lifecycle })

    const first = await wrapped({ senderId: 1 }, 7)
    const second = await wrapped({ senderId: 1 }, 7)
    expect(first).toEqual({ x: 7 })
    expect(second).toEqual({ x: 7 })
    expect(isIpcUnchangedSentinel(second)).toBe(false)
  })
})
