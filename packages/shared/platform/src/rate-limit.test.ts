/**
 * Flood-limit primitives (T-26): fixed windows that a steady poller never trips, the
 * IPv6 /64 bucket, the key bound, and the once-per-window refusal line.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  addressBucket,
  createFixedWindowLimiter,
  createRateLimitAudit,
  type RateRule
} from './rate-limit'
import { setSecurityLogSink } from './security-log'

const clock = () => {
  let t = 1_000_000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('createFixedWindowLimiter', () => {
  const rule: RateRule = { max: 3, windowMs: 10_000 }

  it('allows max per window, refuses the next with the time left, reopens after', () => {
    const c = clock()
    const l = createFixedWindowLimiter({ now: c.now })
    for (let i = 0; i < 3; i++) expect(l.consume('a', rule).allowed).toBe(true)
    c.advance(4_000)
    expect(l.consume('a', rule)).toEqual({ allowed: false, retryAfterSec: 6 })
    // Another key is untouched.
    expect(l.consume('b', rule).allowed).toBe(true)
    c.advance(6_000)
    expect(l.consume('a', rule).allowed).toBe(true)
  })

  it('a refused request does not extend the window', () => {
    const c = clock()
    const l = createFixedWindowLimiter({ now: c.now })
    for (let i = 0; i < 3; i++) l.consume('a', rule)
    for (let i = 0; i < 9; i++) {
      c.advance(1_000)
      expect(l.consume('a', rule).allowed).toBe(false)
    }
    c.advance(1_000)
    expect(l.consume('a', rule).allowed).toBe(true)
  })

  it('a steady poller under the rate is never refused (unlike a window that restarts per request)', () => {
    const c = clock()
    const l = createFixedWindowLimiter({ now: c.now })
    const poll: RateRule = { max: 12, windowMs: 60_000 }
    for (let i = 0; i < 12 * 30; i++) {
      expect(l.consume('cli', poll).allowed).toBe(true)
      c.advance(5_000)
    }
  })

  it('check reads without counting; hit counts past max', () => {
    const c = clock()
    const l = createFixedWindowLimiter({ now: c.now })
    expect(l.check('a', rule).allowed).toBe(true)
    expect(l.size()).toBe(0)
    for (let i = 0; i < 5; i++) l.hit('a', rule)
    expect(l.check('a', rule).allowed).toBe(false)
    c.advance(10_000)
    expect(l.check('a', rule).allowed).toBe(true)
  })

  it('holds at most maxKeys keys', () => {
    const c = clock()
    const l = createFixedWindowLimiter({ now: c.now, maxKeys: 100 })
    for (let i = 0; i < 1_000; i++) l.consume(`k${i}`, rule)
    expect(l.size()).toBeLessThanOrEqual(100)
    // The newest key kept its count.
    l.consume('k999', rule)
    l.consume('k999', rule)
    expect(l.consume('k999', rule).allowed).toBe(false)
  })
})

describe('addressBucket', () => {
  it('IPv4 as is, IPv6 as its /64, mapped IPv4 as IPv4, nothing as unknown', () => {
    expect(addressBucket('203.0.113.7')).toBe('203.0.113.7')
    expect(addressBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
    expect(addressBucket('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(addressBucket('2001:DB8::1')).toBe('2001:db8:0:0::/64')
    expect(addressBucket('::ffff:198.51.100.4')).toBe('198.51.100.4')
    expect(addressBucket(null)).toBe('unknown')
    expect(addressBucket('not-an-ip')).toBe('not-an-ip')
  })
})

describe('createRateLimitAudit', () => {
  afterEach(() => setSecurityLogSink())

  it('one hub.rate_limit line per limit and address bucket per window', () => {
    const lines: Record<string, unknown>[] = []
    setSecurityLogSink((line) => lines.push(JSON.parse(line)))
    const c = clock()
    const audit = createRateLimitAudit({ now: c.now })
    const refusal = { limit: 'x', address: '2001:db8::1', route: 'WS /computers', max: 8 }
    expect(audit(refusal)).toBe(true)
    for (let i = 0; i < 50; i++) expect(audit(refusal)).toBe(false)
    // Same /64: still the same source.
    expect(audit({ ...refusal, address: '2001:db8::2' })).toBe(false)
    expect(audit({ ...refusal, limit: 'y' })).toBe(true)
    expect(audit({ ...refusal, address: '198.51.100.1' })).toBe(true)
    c.advance(60_000)
    expect(audit(refusal)).toBe(true)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatchObject({
      type: 'security',
      event: 'hub.rate_limit',
      outcome: 'denied',
      ip: '2001:db8::1',
      route: 'WS /computers',
      targetKind: 'hub',
      detail: { limit: 'x', max: 8, auditWindowSec: 60 }
    })
  })
})
