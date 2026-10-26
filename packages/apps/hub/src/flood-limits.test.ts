/**
 * The hub's front-door flood limits (T-26, flood-limits.ts): web-login and break-glass
 * redemption per client address, `/trpc` upgrades and open sockets per address, the key
 * being the address the hub resolved (a spoofed `X-Forwarded-For` from an untrusted peer
 * does not move it), one audit line per flood, and nothing at all where the guard is off
 * (the desktop app's hub).
 *
 * Run with: npx tsx packages/apps/hub/src/flood-limits.test.ts
 */
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

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`)
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

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

console.log('\nflood-limits')

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
    assert(!refused && r.out.status === 0, `attempt ${i + 1} passes untouched`)
  }
  const r = response()
  assert(
    guard.refuseRequest(request('POST', '/api/auth/web-login', '203.0.113.30', '192.0.2.1'), r.res),
    'over the limit'
  )
  assert(r.out.status === 429, `429, got ${r.out.status}`)
  assert(
    r.out.headers['retry-after'] === '60',
    `retry-after 60, got ${r.out.headers['retry-after']}`
  )
  assert(JSON.parse(r.out.body).ok === false, 'json error body')
  // Another address, and the same address on another route, are unaffected.
  assert(
    !guard.refuseRequest(request('POST', '/api/auth/web-login', '203.0.113.31'), response().res),
    'another address passes'
  )
  assert(
    !guard.refuseRequest(request('POST', '/api/auth/get-session', '203.0.113.30'), response().res),
    'an unlisted route passes'
  )
  assert(
    !guard.refuseRequest(request('GET', '/api/auth/web-login', '203.0.113.30'), response().res),
    'only POST is limited'
  )
  for (let i = 0; i < 20; i++) {
    guard.refuseRequest(request('POST', '/api/auth/web-login', '203.0.113.30'), response().res)
  }
  const audit = rateLines(lines)
  assert(audit.length === 1, `one audit line, got ${audit.length}`)
  const detail = audit[0]!.detail as Record<string, unknown>
  assert(audit[0]!.ip === '203.0.113.30', 'audited address')
  assert(audit[0]!.route === 'POST /api/auth/web-login', 'audited route')
  assert(detail.limit === 'http.web_login' && detail.max === max, 'limit named')
  clock.advance(HUB_FLOOD_RULES.webLogin.windowMs)
  assert(
    !guard.refuseRequest(request('POST', '/api/auth/web-login', '203.0.113.30'), response().res),
    'passes again after the window'
  )
  setSecurityLogSink(silent)
})

test('break-glass redemption: 10 per 10 minutes per address', () => {
  const clock = withClock()
  const guard = createHubFloodGuard({ enabled: true, now: clock.now })
  const max = HUB_FLOOD_RULES.breakGlassRedeem.max
  for (let i = 0; i < max; i++) {
    assert(
      !guard.refuseRequest(request('POST', BREAK_GLASS_PATH, '203.0.113.40'), response().res),
      `redeem ${i + 1}`
    )
  }
  const r = response()
  assert(guard.refuseRequest(request('POST', BREAK_GLASS_PATH, '203.0.113.40'), r.res), 'refused')
  assert(
    r.out.headers['retry-after'] === '600',
    `retry-after 600, got ${r.out.headers['retry-after']}`
  )
  // Ending the session (DELETE, with its bearer) is not a redemption.
  assert(
    !guard.refuseRequest(request('DELETE', BREAK_GLASS_PATH, '203.0.113.40'), response().res),
    'DELETE passes'
  )
})

class FakeWs extends EventEmitter {}

test('/trpc: at most 64 open sockets per address; a closed one frees its slot', () => {
  const lines = captureAudit()
  const guard = createHubFloodGuard({ enabled: true })
  const open: FakeWs[] = []
  for (let i = 0; i < TRPC_SOCKETS_PER_ADDRESS; i++) {
    const admission = guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.50'))
    assert(admission.ok, `socket ${i + 1} admitted`)
    const ws = new FakeWs()
    admission.track(ws)
    open.push(ws)
  }
  const refused = guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.50'))
  assert(!refused.ok && refused.status === 429, 'the next is refused')
  assert(!refused.ok && refused.limit === 'trpc.sockets_per_address', 'by the socket cap')
  assert(guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.51')).ok, 'another address')
  open[0]!.emit('close')
  assert(guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.50')).ok, 'slot freed')
  assert(rateLines(lines).length === 1, 'one audit line')
  setSecurityLogSink(silent)
})

test('/trpc: at most 120 upgrades a minute per address, however short-lived', () => {
  const clock = withClock()
  const guard = createHubFloodGuard({ enabled: true, now: clock.now })
  for (let i = 0; i < HUB_FLOOD_RULES.trpcUpgrades.max; i++) {
    const admission = guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.60'))
    assert(admission.ok, `upgrade ${i + 1}`)
    const ws = new FakeWs()
    admission.track(ws)
    ws.emit('close')
  }
  const refused = guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.60'))
  assert(!refused.ok && refused.limit === 'trpc.upgrades', 'refused by the rate')
  clock.advance(60_000)
  assert(guard.admitTrpcUpgrade(request('GET', '/trpc', '203.0.113.60')).ok, 'next window')
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
      assert(
        !guard.refuseRequest(request(method, url, '203.0.113.80'), response().res),
        `${path} ${i + 1} passes`
      )
    }
    const r = response()
    assert(guard.refuseRequest(request(method, path, '203.0.113.80'), r.res), `${path} over`)
    assert(r.out.status === 429, `${path} 429`)
    assert(
      !guard.refuseRequest(request(method, path, '203.0.113.81'), response().res),
      `${path}: another address passes`
    )
  }
  assert(HUB_FLOOD_RULES.webSso.max === 20, 'two requests per Entra sign-in, 10 sign-ins a minute')
  const limits = rateLines(lines).map((l) => (l.detail as { limit?: string }).limit)
  assert(
    limits.join(',') === 'http.web_sso,http.web_session,http.web_logout',
    `one line per flood, got ${limits.join(',')}`
  )
  // Other methods on those paths are not counted (the routes answer them 405).
  assert(
    !guard.refuseRequest(request('POST', '/api/auth/web-sso', '203.0.113.80'), response().res),
    'POST web-sso is not the limited route'
  )
  setSecurityLogSink(silent)
})

test('the device sign-in page (T-110): start leg 20/min, approve+deny share 300/min', () => {
  const lines = captureAudit()
  const clock = withClock()
  const guard = createHubFloodGuard({ enabled: true, now: clock.now })
  const start = HUB_FLOOD_RULES.deviceStart.max
  assert(start === HUB_FLOOD_RULES.webSso.max, 'same budget as web-sso')
  for (let i = 0; i < start; i++) {
    // Opening with a code, the return leg from Entra, a retry: all the same path.
    const url =
      i % 2 === 0 ? '/device' : `/device?user_code=ABCDEFGH${i % 4 ? '&signin=failed' : ''}`
    assert(
      !guard.refuseRequest(request('GET', url, '203.0.113.90'), response().res),
      `start ${i + 1} passes`
    )
  }
  const over = response()
  assert(
    guard.refuseRequest(request('GET', '/device?user_code=ABCDEFGH', '203.0.113.90'), over.res),
    'start N+1 refused'
  )
  assert(over.out.status === 429, '429')
  assert(Number(over.out.headers['retry-after']) > 0, 'retry-after')
  assert(
    !guard.refuseRequest(request('GET', '/device', '203.0.113.91'), response().res),
    'another address passes'
  )
  // The forms count separately from the start leg, and approve + deny share one bucket.
  const decide = HUB_FLOOD_RULES.deviceDecide.max
  for (let i = 0; i < decide; i++) {
    const path = i % 2 === 0 ? '/device/approve' : '/device/deny'
    assert(
      !guard.refuseRequest(request('POST', path, '203.0.113.90'), response().res),
      `decide ${i + 1} passes`
    )
  }
  const r = response()
  assert(guard.refuseRequest(request('POST', '/device/deny', '203.0.113.90'), r.res), 'over')
  assert(r.out.status === 429, 'decide 429')
  const limits = rateLines(lines).map((l) => (l.detail as { limit?: string }).limit)
  assert(
    limits.join(',') === 'http.device_start,http.device_decide',
    `one line per flood, got ${limits.join(',')}`
  )
  clock.advance(60_000)
  assert(
    !guard.refuseRequest(request('GET', '/device', '203.0.113.90'), response().res),
    'next window'
  )
  setSecurityLogSink(silent)
})

test('off (the desktop app’s hub): nothing refused, nothing counted, nothing audited', () => {
  const lines = captureAudit()
  const guard = createHubFloodGuard({ enabled: false })
  assert(!guard.enabled, 'reports off')
  for (let i = 0; i < 500; i++) {
    assert(
      !guard.refuseRequest(request('POST', '/api/auth/web-login', '127.0.0.1'), response().res),
      'web-login'
    )
    for (const [method, path] of [
      ['GET', '/device?user_code=ABCDEFGH'],
      ['POST', '/device/approve'],
      ['GET', '/api/auth/web-sso']
    ]) {
      assert(!guard.refuseRequest(request(method!, path!, '127.0.0.1'), response().res), path!)
    }
    const admission = guard.admitTrpcUpgrade(request('GET', '/trpc', '127.0.0.1'))
    assert(admission.ok, 'trpc')
    admission.track(new FakeWs())
  }
  assert(rateLines(lines).length === 0, 'no audit line')
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
  assert(written[0]?.startsWith('HTTP/1.1 429 Too Many Requests\r\n'), 'status line')
  assert(written[0]?.includes('Retry-After: 7\r\n'), 'retry-after')
  assert(destroyed, 'destroyed')
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
  assert(destroyed, 'destroyed after a failed write')
})

setSecurityLogSink()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
