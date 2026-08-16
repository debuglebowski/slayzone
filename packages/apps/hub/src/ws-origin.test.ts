/**
 * The `/trpc` WebSocket origin guard.
 *
 * This decision had NO test before it was extracted from `startServer` — it was a
 * closure you could not reach without booting two listeners. Everything below is
 * the coverage that absence was hiding, in the same shape `rest-auth.test.ts`
 * uses (hand-rolled harness, pure function, no boot).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/ws-origin.test.ts
 */
import { wsOriginDecision, resolveAllowedWebOrigins } from './ws-origin.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`)
}

/** The three deployment shapes, named once so each case reads as a scenario. */
const SUPERVISED = { supervised: true, loopbackBind: true } as const
const STANDALONE_LOOPBACK = { supervised: false, loopbackBind: true } as const
const INTERNET_FACING = { supervised: false, loopbackBind: false } as const

console.log('\n/trpc WebSocket origin guard')
console.log('─'.repeat(52))

// ── non-browser callers ───────────────────────────────────────────────────────
test('an ABSENT Origin is accepted everywhere (non-browser clients)', () => {
  // Browsers always send Origin on a WS handshake, so no-Origin means Electron
  // main, node tooling, e2e, the sidecar or `slay`. They cannot be confused
  // deputies and are bearer-gated afterwards. Rejecting them would break every
  // native client on an enforcing hub.
  for (const shape of [SUPERVISED, STANDALONE_LOOPBACK, INTERNET_FACING]) {
    assertEq(
      wsOriginDecision({ origin: undefined, ...shape }),
      'accept',
      `no Origin accepted (loopbackBind=${shape.loopbackBind})`
    )
  }
})

// ── the opaque origin — the one that was actively dangerous ──────────────────
test('Origin: null is accepted LOCALLY but rejected on an internet-facing hub', () => {
  // `null` is what file:// serializes to — and what ANY sandboxed iframe sends.
  // Any website can embed `<iframe sandbox>` without allow-same-origin, so
  // blanket-accepting it meant "accept every website" on a reachable hub.
  assertEq(wsOriginDecision({ origin: 'null', ...SUPERVISED }), 'accept', 'packaged Electron')
  assertEq(wsOriginDecision({ origin: 'null', ...STANDALONE_LOOPBACK }), 'accept', 'local dev')
  assertEq(
    wsOriginDecision({ origin: 'null', ...INTERNET_FACING }),
    'reject',
    'a sandboxed iframe on any website must not open /trpc'
  )
})

test('first-party renderer protocols follow the same rule as null', () => {
  for (const origin of [
    'chrome://slayzone-shell',
    'chrome-extension://abcdefghijklmnop',
    'devtools://devtools',
    'file:///Applications/SlayZone.app/index.html'
  ]) {
    assertEq(wsOriginDecision({ origin, ...SUPERVISED }), 'accept', `${origin} local`)
    assertEq(
      wsOriginDecision({ origin, ...STANDALONE_LOOPBACK }),
      'accept',
      `${origin} standalone loopback (the Chromium fork's own backend)`
    )
    assertEq(wsOriginDecision({ origin, ...INTERNET_FACING }), 'reject', `${origin} exposed`)
  }
})

// ── localhost ─────────────────────────────────────────────────────────────────
test('localhost origins are accepted whenever the hub binds loopback', () => {
  // The fork dev server (51734) and the web dev server (51735) both live here, on
  // a hub that is standalone and therefore auth-enforcing — so this must NOT be
  // gated on `supervised`, or `pnpm dev:chromium` stops connecting.
  for (const origin of [
    'http://localhost:51734',
    'http://localhost:51735',
    'http://127.0.0.1:8765',
    'http://[::1]:8765'
  ]) {
    assertEq(
      wsOriginDecision({ origin, ...STANDALONE_LOOPBACK }),
      'accept',
      `${origin} on a loopback-bound standalone hub`
    )
  }
})

test('localhost is REJECTED once the hub binds off-box', () => {
  // A hub on 0.0.0.0 has no business trusting a localhost origin: the only way a
  // browser sends one is if the attacker controls a page on the victim's own
  // machine, which is exactly the DNS-rebind shape this guard exists for.
  assertEq(
    wsOriginDecision({ origin: 'http://localhost:51735', ...INTERNET_FACING }),
    'reject',
    'localhost origin on an exposed hub'
  )
})

// ── foreign origins ───────────────────────────────────────────────────────────
test('a foreign website is rejected in every deployment shape', () => {
  for (const shape of [SUPERVISED, STANDALONE_LOOPBACK, INTERNET_FACING]) {
    assertEq(
      wsOriginDecision({ origin: 'https://evil.example', ...shape }),
      'reject',
      `evil.example (loopbackBind=${shape.loopbackBind})`
    )
  }
})

test('an unparseable Origin fails CLOSED', () => {
  for (const origin of ['not a url', '://', 'http://', ' ']) {
    assertEq(
      wsOriginDecision({ origin, ...STANDALONE_LOOPBACK }),
      'reject',
      `unparseable ${JSON.stringify(origin)}`
    )
  }
})

// ── the configured public origin ─────────────────────────────────────────────
test('an explicitly allowed origin is accepted on an internet-facing hub', () => {
  const allowedOrigins = ['https://hub.example.com']
  assertEq(
    wsOriginDecision({ origin: 'https://hub.example.com', ...INTERNET_FACING, allowedOrigins }),
    'accept',
    'the hub own public origin'
  )
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
    assertEq(
      wsOriginDecision({ origin, ...INTERNET_FACING, allowedOrigins }),
      'reject',
      `lookalike rejected: ${origin}`
    )
  }
})

// ── deriving the allowlist ────────────────────────────────────────────────────
test('the public origin is DERIVED from the address a remote hub must already set', () => {
  // A remote hub cannot boot without SLAYZONE_HUB_PUBLIC_ADDRESS, so deriving the
  // browser origin from it means a web-serving hub needs no new configuration and
  // the two values cannot drift.
  assertEq(
    resolveAllowedWebOrigins({
      SLAYZONE_MODE: 'remote',
      SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com'
    }).join(','),
    'https://hub.example.com',
    'remote ⇒ https'
  )
  assertEq(
    resolveAllowedWebOrigins({
      SLAYZONE_MODE: 'local',
      SLAYZONE_HUB_PUBLIC_ADDRESS: 'box.local:8765'
    }).join(','),
    'http://box.local:8765',
    'local ⇒ http, port preserved'
  )
})

test('the env override adds origins and drops junk defensively', () => {
  const origins = resolveAllowedWebOrigins({
    SLAYZONE_HUB_ALLOWED_WEB_ORIGINS: 'https://a.example, ,https://b.example/some/path,nonsense,'
  })
  assertEq(origins.length, 2, `two usable origins, got ${JSON.stringify(origins)}`)
  assertEq(origins[0], 'https://a.example', 'first entry')
  // A trailing path is normalized away — a browser only ever sends the origin.
  assertEq(origins[1], 'https://b.example', 'path stripped to bare origin')
})

test('no configuration at all yields an EMPTY allowlist (never a wildcard)', () => {
  assertEq(resolveAllowedWebOrigins({}).length, 0, 'nothing configured ⇒ nothing extra allowed')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
