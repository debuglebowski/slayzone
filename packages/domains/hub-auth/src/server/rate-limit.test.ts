/**
 * better-auth's rate limiter on the hub (T-26): on by config whatever NODE_ENV says,
 * keyed on the address the hub resolved (a client's `X-Forwarded-For` cannot move it),
 * N+1 sign-ins in a window refused with 429, off where the hub says so, a steady
 * device-token poll never refused, and one audit line per flood, not per request.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptClientAddress, NO_TRUSTED_PROXIES } from '@slayzone/platform/client-address'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHubAuth, type HubAuth } from './auth'
import { AUTH_RATE_LIMIT_RULES, createAuthRateLimitStorage, hubAuthRateLimit } from './rate-limit'

const BASE_URL = 'http://127.0.0.1:9999'
const SECRET = 'hub-auth-rate-limit-test-secret-at-least-32-chars'
const SIGN_IN_MAX = AUTH_RATE_LIMIT_RULES['/sign-in/*']!.max

let tmpDir: string
let limited: HubAuth
let unlimited: HubAuth
let lines: Record<string, unknown>[] = []

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-rate-limit-'))
  limited = await createHubAuth({
    dbPath: join(tmpDir, 'limited.sqlite'),
    baseURL: BASE_URL,
    secret: SECRET
  })
  unlimited = await createHubAuth({
    dbPath: join(tmpDir, 'unlimited.sqlite'),
    baseURL: BASE_URL,
    secret: SECRET,
    rateLimit: false
  })
})

afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

afterEach(() => {
  setSecurityLogSink()
  lines = []
})
const captureAudit = () => setSecurityLogSink((line) => lines.push(JSON.parse(line)))

/**
 * A sign-in as it reaches better-auth through the hub: the hub resolves the client
 * address from the TCP peer (no trusted front end here) and writes it into the one
 * header better-auth reads — whatever `X-Forwarded-For` the client sent.
 */
function signIn(
  auth: HubAuth,
  peer: string,
  forwardedFor?: string,
  route: '/sign-in/email' | '/sign-in/social' = '/sign-in/email'
): Promise<Response> {
  const req = {
    socket: { remoteAddress: peer },
    headers: {
      'content-type': 'application/json',
      origin: BASE_URL,
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {})
    } as Record<string, string | string[] | undefined>
  }
  adoptClientAddress(req, NO_TRUSTED_PROXIES)
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${route}`, {
      method: 'POST',
      headers: req.headers as Record<string, string>,
      body: JSON.stringify(
        route === '/sign-in/email'
          ? { email: 'nobody@example.com', password: 'wrong-password-1' }
          : { provider: 'microsoft', callbackURL: '/' }
      )
    })
  )
}

describe('better-auth rate limit', () => {
  it('is enabled explicitly, never from NODE_ENV', async () => {
    expect(hubAuthRateLimit(true).enabled).toBe(true)
    expect(hubAuthRateLimit(false).enabled).toBe(false)
    expect((await limited.$context).rateLimit.enabled).toBe(true)
    expect((await unlimited.$context).rateLimit.enabled).toBe(false)
  })

  it(`refuses sign-in ${SIGN_IN_MAX + 1} in a window with 429, per resolved address`, async () => {
    captureAudit()
    for (let i = 0; i < SIGN_IN_MAX; i++) {
      // A different spoofed X-Forwarded-For every time: the key stays the peer.
      const res = await signIn(limited, '203.0.113.10', `198.51.100.${i + 1}`)
      expect(res.status).toBe(401)
    }
    const refused = await signIn(limited, '203.0.113.10', '192.0.2.250')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('x-retry-after'))).toBeGreaterThan(0)
    // Another client is unaffected.
    expect((await signIn(limited, '203.0.113.11')).status).toBe(401)
    // More refusals from the same address: still one audit line.
    for (let i = 0; i < 5; i++) {
      expect((await signIn(limited, '203.0.113.10')).status).toBe(429)
    }
    const rateLines = lines.filter((l) => l.event === 'hub.rate_limit')
    expect(rateLines).toHaveLength(1)
    expect(rateLines[0]).toMatchObject({
      outcome: 'denied',
      ip: '203.0.113.10',
      route: '/api/auth/sign-in/email',
      detail: { limit: 'auth/sign-in/email', max: SIGN_IN_MAX, windowSec: 60 }
    })
  })

  it('the Entra sign-in start has the same cap, counted apart from password sign-in', async () => {
    // This hub has no Entra provider, so the route itself refuses — but the limiter
    // answers before any route runs, so the 11th start is a 429 all the same.
    for (let i = 0; i < SIGN_IN_MAX; i++) {
      const res = await signIn(limited, '203.0.113.12', undefined, '/sign-in/social')
      expect(res.status).not.toBe(429)
    }
    expect((await signIn(limited, '203.0.113.12', undefined, '/sign-in/social')).status).toBe(429)
    expect((await signIn(limited, '203.0.113.12')).status).toBe(401)
  })

  it('a hub that turns it off (the desktop app’s loopback hub) refuses nothing', async () => {
    for (let i = 0; i < SIGN_IN_MAX * 3; i++) {
      expect((await signIn(unlimited, '127.0.0.1')).status).toBe(401)
    }
  })
})

describe('createAuthRateLimitStorage', () => {
  it('a device-token poll every 5 s for its whole 10 minutes is never refused', async () => {
    let t = 1_000_000
    const storage = createAuthRateLimitStorage({ now: () => t })
    const rule = AUTH_RATE_LIMIT_RULES['/device/token']!
    // Twelve clients behind one address, polling at the interval the plugin enforces.
    for (let s = 0; s < 600; s += 5) {
      for (let c = 0; c < 12; c++) {
        expect((await storage.consume('203.0.113.20|/device/token', rule)).allowed).toBe(true)
      }
      t += 5_000
    }
  })

  it('collapses an IPv6 client to its /64', async () => {
    const storage = createAuthRateLimitStorage({ now: () => 0 })
    const rule = { window: 60, max: 2 }
    expect((await storage.consume('2001:db8:1:2::1|/sign-in/social', rule)).allowed).toBe(true)
    expect((await storage.consume('2001:db8:1:2::2|/sign-in/social', rule)).allowed).toBe(true)
    expect(await storage.consume('2001:db8:1:2::3|/sign-in/social', rule)).toEqual({
      allowed: false,
      retryAfter: 60
    })
  })
})
