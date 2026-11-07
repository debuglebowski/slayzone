import { describe, expect, it } from 'vitest'
import { SessionReadyGate } from './chat-session-ready'

function deferred(): { promise: Promise<null>; resolve: () => void; reject: () => void } {
  let resolve!: () => void
  let reject!: () => void
  const promise = new Promise<null>((res, rej) => {
    resolve = () => res(null)
    reject = () => rej(new Error('hydrate failed'))
  })
  return { promise, resolve, reject }
}

const settled = async (p: Promise<void>): Promise<boolean> => {
  let done = false
  void p.then(() => (done = true))
  await new Promise((r) => setTimeout(r, 0))
  return done
}

describe('SessionReadyGate', () => {
  it('is ready before any hydrate', async () => {
    expect(await settled(new SessionReadyGate().ready())).toBe(true)
  })

  it('waits for the tracked hydrate', async () => {
    const gate = new SessionReadyGate()
    const h = deferred()
    gate.track(h.promise)
    const ready = gate.ready()
    expect(await settled(ready)).toBe(false)
    h.resolve()
    expect(await settled(ready)).toBe(true)
  })

  it('a failed hydrate holds nothing back', async () => {
    const gate = new SessionReadyGate()
    const h = deferred()
    gate.track(h.promise).catch(() => undefined)
    const ready = gate.ready()
    h.reject()
    expect(await settled(ready)).toBe(true)
  })

  it('waits for a hydrate started while it waited (a reload)', async () => {
    const gate = new SessionReadyGate()
    const first = deferred()
    gate.track(first.promise)
    const ready = gate.ready()
    const second = deferred()
    gate.track(second.promise)
    first.resolve()
    expect(await settled(ready)).toBe(false)
    second.resolve()
    expect(await settled(ready)).toBe(true)
  })
})
