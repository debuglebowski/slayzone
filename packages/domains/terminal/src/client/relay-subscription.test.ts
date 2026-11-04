/**
 * The hub `pty.onData` subscription narrowed to the sessions the hub must relay
 * (docs/direct-link.md), re-opened when that set changes — new one first, the old
 * one closed only once the new one has started, so no chunk falls between them.
 */
import { describe, expect, it } from 'vitest'
import { createRelaySubscription } from './relay-subscription'

function setup() {
  const subs: Array<{ ids: string[]; started: () => void; closed: boolean }> = []
  const relay = createRelaySubscription({
    open: (ids, onStarted) => {
      const sub = { ids, started: onStarted, closed: false }
      subs.push(sub)
      return {
        close: () => {
          sub.closed = true
        }
      }
    }
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { relay, subs, flush }
}

describe('relay subscription', () => {
  it('opens one subscription for the set, sorted and de-duplicated', async () => {
    const { relay, subs, flush } = setup()
    relay.set(['b', 'a', 'a'])
    await flush()
    expect(subs.map((s) => s.ids)).toEqual([['a', 'b']])
  })

  it('coalesces changes within a tick, and ignores an unchanged set', async () => {
    const { relay, subs, flush } = setup()
    relay.set(['a'])
    relay.set(['a', 'b'])
    await flush()
    subs[0]?.started()
    relay.set(['b', 'a'])
    await flush()
    expect(subs.map((s) => s.ids)).toEqual([['a', 'b']])
  })

  it('overlaps: the old subscription closes only after the new one started', async () => {
    const { relay, subs, flush } = setup()
    relay.set(['a'])
    await flush()
    subs[0]?.started()
    relay.set(['a', 'b'])
    await flush()
    expect(subs[0]?.closed).toBe(false)
    subs[1]?.started()
    expect(subs[0]?.closed).toBe(true)
    expect(subs[1]?.closed).toBe(false)
  })

  it('a newer set replaces one still starting, keeping the live one until its successor starts', async () => {
    const { relay, subs, flush } = setup()
    relay.set(['a'])
    await flush()
    subs[0]?.started()
    relay.set(['a', 'b'])
    await flush()
    relay.set(['a', 'c'])
    await flush()
    expect(subs[1]?.closed).toBe(true)
    expect(subs[0]?.closed).toBe(false)
    subs[2]?.started()
    expect(subs[0]?.closed).toBe(true)
  })

  it('relays nothing for an empty set, and close() ends everything', async () => {
    const { relay, subs, flush } = setup()
    relay.set(['a'])
    await flush()
    subs[0]?.started()
    relay.set([])
    await flush()
    expect(subs[0]?.closed).toBe(true)
    expect(subs.length).toBe(1)
    relay.set(['b'])
    await flush()
    relay.close()
    expect(subs[1]?.closed).toBe(true)
  })
})
