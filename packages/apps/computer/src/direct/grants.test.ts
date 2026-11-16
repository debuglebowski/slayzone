import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDirectGrantStore, type DirectGrantStore, type GrantRecord } from './grants'

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
const token = (n: number) => `tok-${n}-${'x'.repeat(40)}`

let clock = 0
const stores: DirectGrantStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  vi.useRealTimers()
})

let wall = 0

function setup(maxPerHub?: number) {
  clock = 1_000
  wall = Date.parse('2026-11-09T12:00:00Z')
  const dropped: Array<{ grants: GrantRecord[]; reason: string }> = []
  const store = createDirectGrantStore({
    now: () => clock,
    wallNow: () => wall,
    onDropped: (grants, reason) => dropped.push({ grants, reason }),
    ...(maxPerHub ? { maxGrantsPerHub: maxPerHub } : {})
  })
  stores.push(store)
  return { store, dropped }
}

function grant(store: DirectGrantStore, n: number, over: Record<string, unknown> = {}, hub = 'h1') {
  store.grant(hub, {
    grantId: `g${n}`,
    tokenHash: hashOf(token(n)),
    userId: 'u1',
    resource: { kind: 'pty', sessionId: `s${n}` },
    ttlMs: 60_000,
    ...over
  } as Parameters<DirectGrantStore['grant']>[1])
}

describe('direct grant store', () => {
  it('authenticates a registered token by its hash and returns the grant', () => {
    const { store } = setup()
    grant(store, 1)
    expect(store.authenticate(token(1))).toMatchObject({
      grantId: 'g1',
      hubKey: 'h1',
      userId: 'u1',
      resource: { kind: 'pty', sessionId: 's1' }
    })
    expect(store.authenticate(token(2))).toBeNull()
    expect(store.authenticate('')).toBeNull()
  })

  it('never keeps the raw token or exposes the hash', () => {
    const { store } = setup()
    grant(store, 1)
    const rec = store.authenticate(token(1))
    expect(JSON.stringify(rec)).not.toContain(token(1))
    expect(JSON.stringify(rec)).not.toContain(hashOf(token(1)))
  })

  it('expires on its own clock, and reports the drop', () => {
    const { store, dropped } = setup()
    grant(store, 1)
    clock += 59_999
    expect(store.authenticate(token(1))).not.toBeNull()
    clock += 1
    expect(store.authenticate(token(1))).toBeNull()
    expect(dropped).toEqual([
      { grants: [expect.objectContaining({ grantId: 'g1' })], reason: 'expired' }
    ])
  })

  it('absolute notAfter: a grant delivered late still ends at the absolute time, not TTL after receipt', () => {
    const { store, dropped } = setup()
    const notAfter = wall + 10_000 // the account's evidence deadline, set by the hub
    wall += 7_000 // delivered 7 s late (queues, a slow link)
    clock += 7_000
    grant(store, 1, { ttlMs: 300_000, notAfter })
    clock += 2_999
    expect(store.authenticate(token(1))).not.toBeNull()
    clock += 1 // exactly the absolute end: 10 s after the hub sent it
    expect(store.authenticate(token(1))).toBeNull()
    expect(dropped.map((d) => d.reason)).toEqual(['expired'])
  })

  it('absolute notAfter: a grant arriving at or after its end is refused, and an existing grant is untouched', () => {
    const { store } = setup()
    grant(store, 1)
    expect(() => grant(store, 1, { notAfter: wall })).toThrow(/after its absolute end/)
    expect(() => grant(store, 2, { notAfter: wall - 1 })).toThrow(/after its absolute end/)
    expect(store.authenticate(token(1))).not.toBeNull()
    expect(store.size()).toBe(1)
  })

  it('sweeps expired grants without being asked, so open streams close on time', () => {
    vi.useFakeTimers()
    const { store, dropped } = setup()
    grant(store, 1, { ttlMs: 2_000 })
    clock += 2_000
    vi.advanceTimersByTime(2_000)
    expect(dropped.map((d) => d.reason)).toEqual(['expired'])
    expect(store.size()).toBe(0)
  })

  it('revokes by grant, user, resource (any epoch) and all — per hub', () => {
    const { store, dropped } = setup()
    grant(store, 1)
    grant(store, 2, { userId: 'u2' })
    grant(store, 3, { resource: { kind: 'chat', tabId: 't', epoch: 1 } })
    grant(store, 4, { resource: { kind: 'chat', tabId: 't', epoch: 2 } })
    grant(store, 5, {}, 'h2')
    expect(store.revoke('h1', { by: 'grant', grantIds: ['g1', 'nope'] })).toBe(1)
    expect(store.revoke('h1', { by: 'user', userId: 'u2' })).toBe(1)
    expect(store.revoke('h1', { by: 'resource', resource: { kind: 'chat', tabId: 't' } })).toBe(2)
    expect(store.revoke('h1', { by: 'all' })).toBe(0)
    expect(store.authenticate(token(5))).not.toBeNull()
    expect(store.revoke('h2', { by: 'grant', grantIds: ['g5'] })).toBe(1)
    expect(dropped.every((d) => d.reason === 'revoked')).toBe(true)
    expect(store.size()).toBe(0)
  })

  it('a hub can only revoke its own grants', () => {
    const { store } = setup()
    grant(store, 1, {}, 'h2')
    expect(store.revoke('h1', { by: 'grant', grantIds: ['g1'] })).toBe(0)
    expect(store.revoke('h1', { by: 'all' })).toBe(0)
    expect(store.authenticate(token(1))).not.toBeNull()
  })

  it('reset keeps only listed grants of that hub', () => {
    const { store, dropped } = setup()
    grant(store, 1)
    grant(store, 2)
    grant(store, 3, {}, 'h2')
    expect(store.reset('h1', ['g2'])).toBe(1)
    expect(store.authenticate(token(1))).toBeNull()
    expect(store.authenticate(token(2))).not.toBeNull()
    expect(store.authenticate(token(3))).not.toBeNull()
    expect(dropped).toEqual([
      { grants: [expect.objectContaining({ grantId: 'g1' })], reason: 'reset' }
    ])
  })

  it('a repeated grant id replaces the old one (hub retry after a lost reply)', () => {
    const { store } = setup()
    grant(store, 1)
    store.grant('h1', {
      grantId: 'g1',
      tokenHash: hashOf(token(9)),
      userId: 'u1',
      resource: { kind: 'pty', sessionId: 's1' },
      ttlMs: 60_000
    })
    expect(store.authenticate(token(1))).toBeNull()
    expect(store.authenticate(token(9))?.grantId).toBe('g1')
    expect(store.size()).toBe(1)
  })

  it('bounds grants per hub', () => {
    const { store } = setup(2)
    grant(store, 1)
    grant(store, 2)
    expect(() => grant(store, 3)).toThrow(/too many/i)
    grant(store, 3, {}, 'h2')
  })
})
