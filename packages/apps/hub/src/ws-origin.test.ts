/**
 * The `/trpc` WebSocket origin guard.
 *
 * This decision had NO test before it was extracted from `startServer` — it was a
 * closure you could not reach without booting two listeners. Everything below is
 * the coverage that absence was hiding, in the same shape `rest-auth.test.ts`
 * uses (pure function, no boot).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/ws-origin.test.ts
 */
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import { expect, test } from 'vitest'
import { cookieOriginDecision, wsOriginDecision, resolveAllowedWebOrigins } from './ws-origin.js'

/** The three deployment shapes, named once so each case reads as a scenario. */
/** The desktop app's hub: login off, so by rule B1 it is reachable only from this machine. */
const DESKTOP_APP = { requireLogin: false, loopbackBind: true } as const
/** A login-required hub that only this machine can reach (dev, the Chromium fork's backend). */
const STANDALONE_LOOPBACK = { requireLogin: true, loopbackBind: true } as const
/** Reachable from other machines: it listens off-loopback, OR a public address is set
 *  (a same-box reverse proxy) — the server computes `loopbackBind` false for both. */
const INTERNET_FACING = { requireLogin: true, loopbackBind: false } as const

// ── non-browser callers ───────────────────────────────────────────────────────
test('an ABSENT Origin is accepted everywhere (non-browser clients)', () => {
  // Browsers always send Origin on a WS handshake, so no-Origin means Electron
  // main, node tooling, e2e, the sidecar or `slay`. They cannot be confused
  // deputies and are bearer-gated afterwards. Rejecting them would break every
  // native client on an enforcing hub.
  for (const shape of [DESKTOP_APP, STANDALONE_LOOPBACK, INTERNET_FACING]) {
    expect(
      wsOriginDecision({ origin: undefined, ...shape }),
      `no Origin accepted (loopbackBind=${shape.loopbackBind})`
    ).toBe('accept')
  }
})

// ── the opaque origin — the one that was actively dangerous ──────────────────
test('Origin: null is accepted LOCALLY but rejected on an internet-facing hub', () => {
  // `null` is what file:// serializes to — and what ANY sandboxed iframe sends.
  // Any website can embed `<iframe sandbox>` without allow-same-origin, so
  // blanket-accepting it meant "accept every website" on a reachable hub.
  expect(wsOriginDecision({ origin: 'null', ...DESKTOP_APP }), 'packaged Electron').toBe('accept')
  expect(wsOriginDecision({ origin: 'null', ...STANDALONE_LOOPBACK }), 'local dev').toBe('accept')
  expect(
    wsOriginDecision({ origin: 'null', ...INTERNET_FACING }),
    'a sandboxed iframe on any website must not open /trpc'
  ).toBe('reject')
})

test('first-party renderer protocols follow the same rule as null', () => {
  for (const origin of [
    'chrome://slayzone-shell',
    'chrome-extension://abcdefghijklmnop',
    'devtools://devtools',
    'file:///Applications/SlayZone.app/index.html'
  ]) {
    expect(wsOriginDecision({ origin, ...DESKTOP_APP }), `${origin} local`).toBe('accept')
    expect(
      wsOriginDecision({ origin, ...STANDALONE_LOOPBACK }),
      `${origin} standalone loopback (the Chromium fork's own backend)`
    ).toBe('accept')
    expect(wsOriginDecision({ origin, ...INTERNET_FACING }), `${origin} exposed`).toBe('reject')
  }
})

// ── localhost ─────────────────────────────────────────────────────────────────
test('localhost origins are accepted whenever the hub binds loopback', () => {
  // The fork dev server (51734) and the web dev server (51735) both live here, on
  // a hub that requires login — so this must NOT be
  // gated on the desktop app, or `pnpm dev:chromium` stops connecting.
  for (const origin of [
    'http://localhost:51734',
    'http://localhost:51735',
    'http://127.0.0.1:8765',
    'http://[::1]:8765'
  ]) {
    expect(
      wsOriginDecision({ origin, ...STANDALONE_LOOPBACK }),
      `${origin} on a loopback-bound standalone hub`
    ).toBe('accept')
  }
})

test('localhost is REJECTED once the hub binds off-box', () => {
  // A hub on 0.0.0.0 has no business trusting a localhost origin: the only way a
  // browser sends one is if the attacker controls a page on the victim's own
  // machine, which is exactly the DNS-rebind shape this guard exists for.
  expect(
    wsOriginDecision({ origin: 'http://localhost:51735', ...INTERNET_FACING }),
    'localhost origin on an exposed hub'
  ).toBe('reject')
})

// ── the desktop app against a login hub other machines reach ──────────────────
test('the desktop reaches a remote login hub ONLY Origin-less, never by its renderer origin', () => {
  // Measured 2026-10-29 on slay.normain.com: every desktop /trpc upgrade was refused with
  // `reason: origin`. These are the two origins those refusals logged — the packaged
  // renderer and the dev server — and both STAY refused: `file://` is also every other
  // Electron app's page, and a localhost origin is any local web page.
  const allowedOrigins = ['https://slay.normain.com']
  for (const origin of ['file://', 'http://localhost:5173']) {
    expect(
      wsOriginDecision({ origin, ...INTERNET_FACING, allowedOrigins }),
      `${origin} refused`
    ).toBe('reject')
  }
  // The desktop's path: Electron main removes Origin from the app document's own /trpc
  // sockets (app `hub-socket-origin.ts`), so the hub admits them as a native client...
  expect(
    wsOriginDecision({ origin: undefined, ...INTERNET_FACING, allowedOrigins }),
    'Origin-less desktop socket'
  ).toBe('accept')
  // ...that authenticates by its bearer alone: an absent Origin never earns the cookie.
  expect(
    cookieOriginDecision({
      origin: undefined,
      host: 'slay.normain.com',
      loopbackBind: false,
      allowedOrigins
    }),
    'no cookie principal for an Origin-less socket'
  ).toBe('reject')
  // Nothing else moved: the opaque origin and a website stay refused.
  for (const origin of ['null', 'https://evil.example']) {
    expect(
      wsOriginDecision({ origin, ...INTERNET_FACING, allowedOrigins }),
      `${origin} still refused`
    ).toBe('reject')
  }
})

// ── foreign origins ───────────────────────────────────────────────────────────
test('a foreign website is rejected in every deployment shape', () => {
  for (const shape of [DESKTOP_APP, STANDALONE_LOOPBACK, INTERNET_FACING]) {
    expect(
      wsOriginDecision({ origin: 'https://evil.example', ...shape }),
      `evil.example (loopbackBind=${shape.loopbackBind})`
    ).toBe('reject')
  }
})

test('an unparseable Origin fails CLOSED', () => {
  for (const origin of ['not a url', '://', 'http://', ' ']) {
    expect(
      wsOriginDecision({ origin, ...STANDALONE_LOOPBACK }),
      `unparseable ${JSON.stringify(origin)}`
    ).toBe('reject')
  }
})

// ── the configured public origin ─────────────────────────────────────────────
test('an explicitly allowed origin is accepted on an internet-facing hub', () => {
  const allowedOrigins = ['https://hub.example.com']
  expect(
    wsOriginDecision({ origin: 'https://hub.example.com', ...INTERNET_FACING, allowedOrigins }),
    'the hub own public origin'
  ).toBe('accept')
})

test('allowlisting compares the FULL origin — no suffix, port or scheme confusion', () => {
  const allowedOrigins = ['https://hub.example.com']
  for (const origin of [
    // The classic suffix attack the old hostname-only comparison invited.
    'https://hub.example.com.evil.test',
    'https://evil.test/?x=https://hub.example.com',
    // Same host, wrong scheme — a downgrade must not be admitted.
    'http://hub.example.com',
    // Same host, wrong port.
    'https://hub.example.com:8443',
    // Subdomain.
    'https://api.hub.example.com'
  ]) {
    expect(
      wsOriginDecision({ origin, ...INTERNET_FACING, allowedOrigins }),
      `lookalike rejected: ${origin}`
    ).toBe('reject')
  }
})

// ── deriving the allowlist ────────────────────────────────────────────────────
test('the public origin is DERIVED from the address a reachable hub must already set', () => {
  // A hub other machines can reach cannot boot without SLAYZONE_HUB_PUBLIC_ADDRESS,
  // so deriving the browser origin from it means a web-serving hub needs no new
  // configuration and the two values cannot drift. The scheme follows the HOST
  // (rule A1): a front end serves TLS for anything that is not loopback.
  expect(
    resolveAllowedWebOrigins({ SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com' }).join(','),
    'public host ⇒ https'
  ).toBe('https://hub.example.com')
  expect(
    resolveAllowedWebOrigins({ SLAYZONE_HUB_PUBLIC_ADDRESS: 'box.local:8765' }).join(','),
    'any non-loopback host ⇒ https, port preserved'
  ).toBe('https://box.local:8765')
  expect(
    resolveAllowedWebOrigins({ SLAYZONE_HUB_PUBLIC_ADDRESS: 'localhost:8443' }).join(','),
    'a loopback public address (same-box proxy under test) ⇒ http'
  ).toBe('http://localhost:8443')
  // The retired SLAYZONE_MODE must not change the answer in either direction.
  expect(
    resolveAllowedWebOrigins({
      SLAYZONE_MODE: 'local',
      SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com'
    }).join(','),
    'a leftover SLAYZONE_MODE=local does not downgrade the scheme'
  ).toBe('https://hub.example.com')
})

/**
 * The Origin React Native's iOS WebSocket (SocketRocket's `-[NSURL SR_origin]`) sends for
 * a socket URL: `wss` → `https`, `ws` → `http`, the host, and the port unless it is the
 * scheme's default (443 / 80).
 */
function socketRocketOrigin(wsUrl: string): string {
  const u = new URL(wsUrl)
  const scheme = u.protocol === 'wss:' ? 'https' : 'http'
  const defaultPort = scheme === 'https' ? '443' : '80'
  return `${scheme}://${u.hostname}${u.port && u.port !== defaultPort ? `:${u.port}` : ''}`
}

test('a native client that sends an Origin (React Native iOS) is accepted at the public address', () => {
  // Unlike desktop's node client, React Native iOS ALWAYS sends an Origin on the
  // handshake, derived from the URL it dials. The mobile app dials the public address
  // the way desktop registers a remote hub (`hubUrlFromAddr(address, 'ws', '/trpc')`),
  // so that Origin must equal the one the hub derives from the same address — or the
  // phone can never open /trpc on a reachable hub.
  for (const [address, origin] of [
    ['hub.example.com', 'https://hub.example.com'],
    // An explicit default port is dropped on both sides.
    ['hub.example.com:443', 'https://hub.example.com'],
    ['box.local:8765', 'https://box.local:8765'],
    ['192.168.1.20:8765', 'https://192.168.1.20:8765']
  ] as const) {
    const wsUrl = hubUrlFromAddr(address, 'ws', '/trpc')
    expect(wsUrl.startsWith('wss://'), `${address} is dialled over wss`).toBe(true)
    expect(socketRocketOrigin(wsUrl), `Origin sent for ${wsUrl}`).toBe(origin)
    const allowedOrigins = resolveAllowedWebOrigins({ SLAYZONE_HUB_PUBLIC_ADDRESS: address })
    expect(
      wsOriginDecision({ origin, ...INTERNET_FACING, allowedOrigins }),
      `${origin} on a hub whose public address is ${address}`
    ).toBe('accept')
  }
})

test('a login-off hub trusts local-client origins; turning login on closes them to a reachable hub', () => {
  expect(
    wsOriginDecision({ origin: 'null', requireLogin: false, loopbackBind: false }),
    'login off ⇒ (by B1) reachable only from this machine ⇒ first-party clients'
  ).toBe('accept')
  expect(
    wsOriginDecision({ origin: 'null', requireLogin: true, loopbackBind: false }),
    'login on and reachable ⇒ a sandboxed iframe must not open /trpc'
  ).toBe('reject')
})

test('the env override adds origins and drops junk defensively', () => {
  const origins = resolveAllowedWebOrigins({
    SLAYZONE_HUB_ALLOWED_WEB_ORIGINS: 'https://a.example, ,https://b.example/some/path,nonsense,'
  })
  expect(origins.length, `two usable origins, got ${JSON.stringify(origins)}`).toBe(2)
  expect(origins[0], 'first entry').toBe('https://a.example')
  // A trailing path is normalized away — a browser only ever sends the origin.
  expect(origins[1], 'path stripped to bare origin').toBe('https://b.example')
})

test('the env override never adds an OPAQUE origin: file:// is not a web origin', () => {
  // `new URL('file://').origin` is "null" — the origin every sandboxed iframe sends. So
  // `SLAYZONE_HUB_ALLOWED_WEB_ORIGINS=file://`, the obvious try when the desktop is
  // refused, put "null" on the allowlist: every website could open /trpc, and
  // better-auth trusted "null" too (`trustedOrigins` is this list).
  const origins = resolveAllowedWebOrigins({
    SLAYZONE_HUB_ALLOWED_WEB_ORIGINS: 'file://,chrome-extension://abc,ftp://x.example,https://ok.example'
  })
  expect(origins.join(','), 'only the http(s) entry survives').toBe('https://ok.example')
  expect(
    wsOriginDecision({
      origin: 'null',
      ...INTERNET_FACING,
      allowedOrigins: resolveAllowedWebOrigins({ SLAYZONE_HUB_ALLOWED_WEB_ORIGINS: 'file://' })
    }),
    'a sandboxed iframe is still refused'
  ).toBe('reject')
})

test('no configuration at all yields an EMPTY allowlist (never a wildcard)', () => {
  expect(resolveAllowedWebOrigins({}).length, 'nothing configured ⇒ nothing extra allowed').toBe(0)
})

// ── the web-session cookie (T-13) ─────────────────────────────────────────────
console.log('\nweb-session cookie: Origin must be the hub page')
const HUB_ORIGIN = 'https://hub.normain.com'
const PUBLIC = { loopbackBind: false, allowedOrigins: [HUB_ORIGIN], host: 'hub.normain.com' }
const LOCAL = { loopbackBind: true, allowedOrigins: [], host: '127.0.0.1:8765' }

test('a reachable hub: only its own public origin authenticates by cookie', () => {
  expect(cookieOriginDecision({ origin: HUB_ORIGIN, ...PUBLIC }), 'own origin').toBe('accept')
  for (const origin of [
    'https://evil.example',
    'https://hub.normain.com.evil.example',
    'http://hub.normain.com',
    'http://localhost:8765',
    'null',
    'file://',
    'chrome://slayzone'
  ]) {
    expect(cookieOriginDecision({ origin, ...PUBLIC }), `${origin} refused`).toBe('reject')
  }
})

test('a MISSING Origin never authenticates by cookie (unlike wsOriginDecision)', () => {
  for (const shape of [PUBLIC, LOCAL]) {
    expect(cookieOriginDecision({ origin: undefined, ...shape }), 'no Origin').toBe('reject')
    expect(cookieOriginDecision({ origin: '', ...shape }), 'blank Origin').toBe('reject')
  }
  expect(
    wsOriginDecision({ origin: undefined, requireLogin: true, loopbackBind: false }),
    'the socket itself still opens for a native client — it just gets no cookie principal'
  ).toBe('accept')
})

test('a repeated or unparseable Origin is refused', () => {
  expect(cookieOriginDecision({ origin: [HUB_ORIGIN, HUB_ORIGIN], ...PUBLIC }), 'array').toBe(
    'reject'
  )
  expect(cookieOriginDecision({ origin: 'not a url', ...LOCAL }), 'junk').toBe('reject')
})

test('a local hub: same origin as the request Host only — not another localhost port', () => {
  expect(cookieOriginDecision({ origin: 'http://127.0.0.1:8765', ...LOCAL }), 'same').toBe('accept')
  expect(
    cookieOriginDecision({ origin: 'http://localhost:8765', ...LOCAL, host: 'LOCALHOST:8765' }),
    'Host compared case-insensitively'
  ).toBe('accept')
  for (const origin of ['http://127.0.0.1:3000', 'http://localhost:8765', 'null', 'file://']) {
    expect(cookieOriginDecision({ origin, ...LOCAL }), `${origin} refused`).toBe('reject')
  }
  expect(
    cookieOriginDecision({ origin: 'http://127.0.0.1:8765', ...LOCAL, host: undefined }),
    'no Host, no same-origin claim'
  ).toBe('reject')
})

test('a non-local hub never matches on Host (a rebinding or proxied name)', () => {
  expect(
    cookieOriginDecision({ origin: 'https://other.example', ...PUBLIC, host: 'other.example' }),
    'Host is attacker-influenced; only the configured origins count off-box'
  ).toBe('reject')
})
