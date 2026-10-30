/**
 * The hub's front-door flood limits (T-26, flood-limits.ts): web-login and break-glass
 * redemption per client address, `/trpc` upgrades and open sockets per address, the key
 * being the address the hub resolved (a spoofed `X-Forwarded-For` from an untrusted peer
 * does not move it), one audit line per flood, and nothing at all where the guard is off
 * (the desktop app's hub).
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { adoptClientAddress, NO_TRUSTED_PROXIES } from '@slayzone/platform/client-address'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { BREAK_GLASS_PATH } from './break-glass'
import {
  createHubFloodGuard,
  HUB_FLOOD_RULES,
  refuseUpgrade,
  TRPC_SOCKETS_PER_ADDRESS
} from './flood-limits'

/** A request as the hub's front door has it: the client address already adopted. */
function request(method: string, url: string, peer: string, forwardedFor?: string) {
  const req = {
    method,
    url,
    socket: { remoteAddress: peer },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}
  } as Record<string, unknown>
  adoptClientAddress(req as never, NO_TRUSTED_PROXIES)
  return req as unknown as IncomingMessage
}

function response() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status
      out.headers = headers
      this.headersSent = true
      return this
    },
    end(body: string) {
      out.body = body
    }
  }
  return { res: res as unknown as ServerResponse, out }
}

function withClock() {
  let t = 5_000_000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

function captureAudit(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = []
  setSecurityLogSink((line) => lines.push(JSON.parse(line)))
  return lines
}
const rateLines = (lines: Record<string, unknown>[]) =>
  lines.filter((l) => l.event === 'hub.rate_limit')

const silent = (): void => undefined
setSecurityLogSink(silent)

test('web-login: the 11th POST in a minute is 429, per resolved address', () => {
  const lines = captureAudit()
  const clock = withClock()
  const guard = createHubFloodGuard({ enabled: true, now: clock.now })
  const max = HUB_FLOOD_RULES.webLogin.max
  for (let i = 0; i < max; i++) {
    // A different spoofed X-Forwarded-For each time: the key stays the TCP peer.
    const r = response()
    const refused = guard.refuseRequest(
      request('POST', '/api/auth/web-login', '203.0.113.30', `198.51.100.${i + 1}`),
      r.res
    )
    expect(refused, `attempt ${i + 1} passes untouched`).toBeFalsy()
    expect(r.out.status, `attempt ${i + 1} passes untouched`).toBe(0)
  }
  const r = response()
  expect(
    guard.refuseRequest(request('POST', '/api/auth/web-login', '203.0.113.30', '192.0.2.1'), r.res),
    'over the limit'
  ).toBeTruthy()
  expect(r.out.status, `429, got ${r.out.status}`).toBe(429)
  expect(r.out.headers['retry-after'], `retry-after 60, got ${r.out.headers['retry-after']}`).toBe(
    '60'
  )
  expect(JSON.parse(r.out.body).ok, 'json error body').toBe(false)
  // Another address, and the same address on another route, are unaffected.
  expect(
    guard.refuseRequest(request('POST', '/api/auth/web-login', '203.0.113.31'), response().res),
    'another address passes'
  ).toBeFalsy()
  expect(
    guard.refuseRequest(request('POST', '/api/auth/get-session', '203.0.113.30'), response().res),
    'an unlisted route passes'
  ).toBeFalsy()
  expect(
    guard.refuseRequest(request('GET', '/api/auth/web-login', '203.0.113.30'), response().res),
    'only POST is limited'
  ).toBeFalsy()
  for (let i = 0; i < 20; i++) {
    guard.refuseRequest(request('POST', '/api/auth/web-login', '203.0.113.30'), response().res)
  }
  const audit = rateLines(lines)
  expect(audit.length, `one audit line, got ${audit.length}`).toBe(1)
  const detail = audit[0]!.detail as Record<string, unknown>
  expect(audit[0]!.ip, 'audited address').toBe('203.0.113.30')
  expect(audit[0]!.route, 'audited route').toBe('POST /api/auth/web-login')
  expect(detail.limit, 'limit named').toBe('http.web_login')
  expect(detail.max, 'limit named').toBe(max)
  clock.advance(HUB_FLOOD_RULES.webLogin.windowMs)
  expect(
    guard.refuseRequest(request('POST', '/api/auth/web-login', '203.0.113.30'), response().res),
    'passes again after the window'
  ).toBeFalsy()
  setSecurityLogSink(silent)
})

test('break-glass redemption: 10 per 10 minutes per address', () => {
  const clock = withClock()
  const guard = createHubFloodGuard({ enabled: true, now: clock.now })
  const max = HUB_FLOOD_RULES.breakGlassRedeem.max
  for (let i = 0; i < max; i++) {
    expect(
      guard.refuseRequest(request('POST', BREAK_GLASS_PATH, '203.0.113.40'), response().res),
      `redeem ${i + 1}`
    ).toBeFalsy()
  }
  const r = response()
  expect(
    guard.refuseRequest(request('POST', BREAK_GLASS_PATH, '203.0.113.40'), r.res),
    'refused'
  ).toBeTruthy()
  expect(r.out.headers['retry-after'], `retry-after 600, got ${r.out.headers['retry-after']}`).toBe(
    '600'
  )
  // Ending the session (DELETE, with its bearer) is not a redemption.
  expect(
    guard.refuseRequest(request('DELETE', BREAK_GLASS_PATH, '203.0.113.40'), response().res),
    'DELETE passes'
  ).toBeFalsy()
})

class FakeWs extends EventEmitter {}

test('/trpc: at most 64 open sockets per address; a closed one frees its slot', () => {
  const lines = captureAudit()
  const guard = createHubFloodGuard({ enabled: true })
  const open: FakeWs[] = []
  for (let i = 0; i < TRPC_SOCKETS_PER_ADDRESS; i++) {
    const admission = guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.50'))
    expect(admission.ok, `socket ${i + 1} admitted`).toBe(true)
    const ws = new FakeWs()
    if (admission.ok) admission.track(ws)
    open.push(ws)
  }
  const refused = guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.50'))
  expect(refused, 'the next is refused, by the socket cap').toMatchObject({
    ok: false,
    status: 429,
    limit: 'trpc.sockets_per_address'
  })
  expect(
    guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.51')).ok,
    'another address'
  ).toBeTruthy()
  open[0]!.emit('close')
  expect(
    guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.50')).ok,
    'slot freed'
  ).toBeTruthy()
  expect(rateLines(lines).length, 'one audit line').toBe(1)
  setSecurityLogSink(silent)
})

test('/trpc: at most 120 upgrades a minute per address, however short-lived', () => {
  const clock = withClock()
  const guard = createHubFloodGuard({ enabled: true, now: clock.now })
  for (let i = 0; i < HUB_FLOOD_RULES.trpcUpgrades.max; i++) {
    const admission = guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.60'))
    expect(admission.ok, `upgrade ${i + 1}`).toBe(true)
    const ws = new FakeWs()
    if (admission.ok) admission.track(ws)
    ws.emit('close')
  }
  const refused = guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.60'))
  expect(refused, 'refused by the rate').toMatchObject({ ok: false, limit: 'trpc.upgrades' })
  clock.advance(60_000)
  expect(
    guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.60')).ok,
    'next window'
  ).toBeTruthy()
})

test('the web shell sign-in and session routes (T-13): limited per address', () => {
  const lines = captureAudit()
  const clock = withClock()
  const guard = createHubFloodGuard({ enabled: true, now: clock.now })
  const cases: Array<[string, string, number]> = [
    ['GET', '/api/auth/web-sso', HUB_FLOOD_RULES.webSso.max],
    ['POST', '/api/auth/web-session', HUB_FLOOD_RULES.webSession.max],
    ['POST', '/api/auth/web-logout', HUB_FLOOD_RULES.webLogout.max]
  ]
  for (const [method, path, max] of cases) {
    for (let i = 0; i < max; i++) {
      // The sign-in's return leg carries a query; it counts against the same path.
      const url = i % 2 === 0 ? path : `${path}?return=1`
      expect(
        guard.refuseRequest(request(method, url, '203.0.113.80'), response().res),
        `${path} ${i + 1} passes`
      ).toBeFalsy()
    }
    const r = response()
    expect(
      guard.refuseRequest(request(method, path, '203.0.113.80'), r.res),
      `${path} over`
    ).toBeTruthy()
    expect(r.out.status, `${path} 429`).toBe(429)
    expect(
      guard.refuseRequest(request(method, path, '203.0.113.81'), response().res),
      `${path}: another address passes`
    ).toBeFalsy()
  }
  expect(HUB_FLOOD_RULES.webSso.max, 'two requests per Entra sign-in, 10 sign-ins a minute').toBe(
    20
  )
  const limits = rateLines(lines).map((l) => (l.detail as { limit?: string }).limit)
  expect(limits.join(','), `one line per flood, got ${limits.join(',')}`).toBe(
    'http.web_sso,http.web_session,http.web_logout'
  )
  // Other methods on those paths are not counted (the routes answer them 405).
  expect(
    guard.refuseRequest(request('POST', '/api/auth/web-sso', '203.0.113.80'), response().res),
    'POST web-sso is not the limited route'
  ).toBeFalsy()
  setSecurityLogSink(silent)
})

test('the device sign-in page (T-110): start leg 20/min, approve+deny share 300/min', () => {
  const lines = captureAudit()
  const clock = withClock()
  const guard = createHubFloodGuard({ enabled: true, now: clock.now })
  const start = HUB_FLOOD_RULES.deviceStart.max
  expect(start, 'same budget as web-sso').toBe(HUB_FLOOD_RULES.webSso.max)
  for (let i = 0; i < start; i++) {
    // Opening with a code, the return leg from Entra, a retry: all the same path.
    const url =
      i % 2 === 0 ? '/device' : `/device?user_code=ABCDEFGH${i % 4 ? '&signin=failed' : ''}`
    expect(
      guard.refuseRequest(request('GET', url, '203.0.113.90'), response().res),
      `start ${i + 1} passes`
    ).toBeFalsy()
  }
  const over = response()
  expect(
    guard.refuseRequest(request('GET', '/device?user_code=ABCDEFGH', '203.0.113.90'), over.res),
    'start N+1 refused'
  ).toBeTruthy()
  expect(over.out.status, '429').toBe(429)
  expect(Number(over.out.headers['retry-after']), 'retry-after').toBeGreaterThan(0)
  expect(
    guard.refuseRequest(request('GET', '/device', '203.0.113.91'), response().res),
    'another address passes'
  ).toBeFalsy()
  // The forms count separately from the start leg, and approve + deny share one bucket.
  const decide = HUB_FLOOD_RULES.deviceDecide.max
  for (let i = 0; i < decide; i++) {
    const path = i % 2 === 0 ? '/device/approve' : '/device/deny'
    expect(
      guard.refuseRequest(request('POST', path, '203.0.113.90'), response().res),
      `decide ${i + 1} passes`
    ).toBeFalsy()
  }
  const r = response()
  expect(
    guard.refuseRequest(request('POST', '/device/deny', '203.0.113.90'), r.res),
    'over'
  ).toBeTruthy()
  expect(r.out.status, 'decide 429').toBe(429)
  const limits = rateLines(lines).map((l) => (l.detail as { limit?: string }).limit)
  expect(limits.join(','), `one line per flood, got ${limits.join(',')}`).toBe(
    'http.device_start,http.device_decide'
  )
  clock.advance(60_000)
  expect(
    guard.refuseRequest(request('GET', '/device', '203.0.113.90'), response().res),
    'next window'
  ).toBeFalsy()
  setSecurityLogSink(silent)
})

test('the app sign-in (Microsoft, native apps): start 20/min, confirm 300/min, token 10/min', () => {
  const lines = captureAudit()
  const clock = withClock()
  const guard = createHubFloodGuard({ enabled: true, now: clock.now })
  expect(HUB_FLOOD_RULES.appSsoStart.max, 'same budget as web-sso').toBe(HUB_FLOOD_RULES.webSso.max)
  expect(HUB_FLOOD_RULES.appSsoConfirm.max, 'same budget as the device forms').toBe(
    HUB_FLOOD_RULES.deviceDecide.max
  )
  expect(HUB_FLOOD_RULES.appSsoToken.max, 'one exchange per sign-in, 10 a minute').toBe(10)
  const cases: Array<[string, string, number]> = [
    ['GET', '/api/auth/app-sso', HUB_FLOOD_RULES.appSsoStart.max],
    ['POST', '/api/auth/app-sso/confirm', HUB_FLOOD_RULES.appSsoConfirm.max],
    ['POST', '/api/auth/app-sso/token', HUB_FLOOD_RULES.appSsoToken.max]
  ]
  for (const [method, path, max] of cases) {
    for (let i = 0; i < max; i++) {
      // The start and return legs share one path (and so one budget).
      const url = i % 2 === 0 ? path : `${path}?return=1`
      expect(
        guard.refuseRequest(request(method, url, '203.0.113.70'), response().res),
        `${path} ${i + 1} passes`
      ).toBeFalsy()
    }
    const r = response()
    expect(
      guard.refuseRequest(request(method, path, '203.0.113.70'), r.res),
      `${path} over`
    ).toBeTruthy()
    expect(r.out.status, `${path} 429`).toBe(429)
    expect(
      guard.refuseRequest(request(method, path, '203.0.113.71'), response().res),
      `${path}: another address passes`
    ).toBeFalsy()
  }
  const limits = rateLines(lines).map((l) => (l.detail as { limit?: string }).limit)
  expect(limits.join(','), `one line per flood, got ${limits.join(',')}`).toBe(
    'http.app_sso_start,http.app_sso_confirm,http.app_sso_token'
  )
  clock.advance(60_000)
  expect(
    guard.refuseRequest(request('POST', '/api/auth/app-sso/token', '203.0.113.70'), response().res),
    'next window'
  ).toBeFalsy()
  setSecurityLogSink(silent)
})

test('off (the desktop app’s hub): nothing refused, nothing counted, nothing audited', () => {
  const lines = captureAudit()
  const guard = createHubFloodGuard({ enabled: false })
  expect(guard.enabled, 'reports off').toBeFalsy()
  for (let i = 0; i < 500; i++) {
    expect(
      guard.refuseRequest(request('POST', '/api/auth/web-login', '127.0.0.1'), response().res),
      'web-login'
    ).toBeFalsy()
    for (const [method, path] of [
      ['GET', '/device?user_code=ABCDEFGH'],
      ['POST', '/device/approve'],
      ['GET', '/api/auth/web-sso']
    ]) {
      expect(
        guard.refuseRequest(request(method!, path!, '127.0.0.1'), response().res),
        path!
      ).toBeFalsy()
    }
    const admission = guard.admitTrpcUpgrade(request('GET', '/trpc', '127.0.0.1'))
    expect(admission.ok, 'trpc').toBe(true)
    if (admission.ok) admission.track(new FakeWs())
  }
  expect(rateLines(lines).length, 'no audit line').toBe(0)
  setSecurityLogSink(silent)
})

test('refuseUpgrade answers on the raw socket and destroys it', () => {
  const written: string[] = []
  let destroyed = false
  const socket = {
    write: (chunk: string) => written.push(chunk),
    destroy: () => {
      destroyed = true
    }
  } as unknown as Duplex
  refuseUpgrade(socket, 429, 7)
  expect(written[0]?.startsWith('HTTP/1.1 429 Too Many Requests\r\n'), 'status line').toBeTruthy()
  expect(written[0], 'retry-after').toContain('Retry-After: 7\r\n')
  expect(destroyed, 'destroyed').toBeTruthy()
  // A socket that throws on write is still destroyed.
  destroyed = false
  refuseUpgrade(
    {
      write: () => {
        throw new Error('EPIPE')
      },
      destroy: () => {
        destroyed = true
      }
    } as unknown as Duplex,
    503,
    1
  )
  expect(destroyed, 'destroyed after a failed write').toBeTruthy()
})

afterAll(() => setSecurityLogSink())
