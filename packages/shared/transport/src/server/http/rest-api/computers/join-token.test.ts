/**
 * REST: POST /api/computers/join-token contract tests (Wave3.5-D3).
 * Run with the electron+loader computer (better-sqlite3 native ABI via the harness DB).
 *
 * The route is the mint channel the Electron MAIN process hits at boot to
 * auto-enroll its local computer (main has no tRPC client to the sidecar), AND the
 * channel `slay computer mint` uses. It wraps the same store `mintJoinToken` as the
 * computers tRPC proc, gated on the `deps.computers` slot (wired once the computer init
 * resolves):
 *   - computer ON + listener bound  → 200 { token (decodable szjt1), hubUrl (wss) }
 *   - computer ON + not-yet-bound   → 503 (main retries)
 *   - computer OFF (slot absent)    → 503 (never mints; default boot byte-identical)
 *
 * WHO MAY CALL IT is a separate axis, decided by the pure `joinTokenAuthDecision`
 * and asserted at the bottom: on a hub with NO auth (no `restAuth` slot —
 * supervised, the Electron host's own boot auto-enroll), loopback is the sole
 * authority. On a hub that ENFORCES auth (every standalone hub now — see
 * server.ts), a bearer is required from everyone, loopback included — that used
 * to be an unconditional loopback bypass, which a reverse proxy in front of a
 * standalone hub turns into "anyone who reaches the hub can mint". The HTTP
 * harness binds 127.0.0.1, so every peer it can produce is loopback — which is
 * exactly why that decision is a pure exported function rather than reachable
 * through a request (same reasoning as the sibling `hub/users.ts` suite).
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { decodeJoinToken } from '@slayzone/computers/server'
import {
  isLoopbackAddress,
  joinTokenAuthDecision,
  registerComputersJoinTokenRoute
} from './join-token.js'
import type { RestApiDeps } from '../types.js'

const h = await createTestHarness()

/** A bound computer listener (computer ON, url + fingerprint present). */
const boundComputers = {
  getHubUrl: () => 'wss://127.0.0.1:54321/computers',
  getCertFingerprint: () => 'abcdef0123456789'
}

function mount(computers: RestApiDeps['computers'], restAuth?: RestApiDeps['restAuth']) {
  const app = express()
  app.use(express.json())
  registerComputersJoinTokenRoute(app, {
    db: h.slayDb,
    notifyRenderer: () => {},
    computers,
    ...(restAuth ? { restAuth } : {})
  })
  return mountRestApp(app)
}

await describe('POST /api/computers/join-token', () => {
  test('computer ON + bound: mints a decodable szjt1 token embedding the wss hub url', async () => {
    const rest = await mount(boundComputers)
    try {
      const res = await rest.request<{ token: string; hubUrl: string }>(
        'POST',
        '/api/computers/join-token',
        { label: 'local-computer' }
      )
      expect(res.status).toBe(200)
      expect(res.body.hubUrl).toBe('wss://127.0.0.1:54321/computers')
      const payload = decodeJoinToken(res.body.token)
      expect(payload).not.toBeNull()
      expect(payload!.hubUrl).toBe('wss://127.0.0.1:54321/computers')
      expect(payload!.certFingerprint).toBe('abcdef0123456789')
    } finally {
      await rest.close()
    }
  })

  test('computer ON but listener not yet bound (null url): 503', async () => {
    const rest = await mount({ getHubUrl: () => null, getCertFingerprint: () => null })
    try {
      const res = await rest.request<{ error: string }>('POST', '/api/computers/join-token', {})
      expect(res.status).toBe(503)
    } finally {
      await rest.close()
    }
  })

  test('computer OFF (computers slot absent): 503, never mints', async () => {
    const rest = await mount(undefined)
    try {
      const res = await rest.request<{ error: string }>('POST', '/api/computers/join-token', {})
      expect(res.status).toBe(503)
    } finally {
      await rest.close()
    }
  })

  test('defaults the label when omitted', async () => {
    const rest = await mount(boundComputers)
    try {
      const res = await rest.request<{ token: string; hubUrl: string }>(
        'POST',
        '/api/computers/join-token',
        {}
      )
      expect(res.status).toBe(200)
      expect(typeof res.body.token).toBe('string')
    } finally {
      await rest.close()
    }
  })

  // NO `restAuth` slot at all (the Electron host's shape): loopback is the sole
  // authority, no bearer is ever consulted. This is the boot auto-enroll path.
  test('with no restAuth slot, loopback mints with no bearer check', async () => {
    const rest = await mount(boundComputers)
    try {
      const res = await rest.request<{ token: string }>('POST', '/api/computers/join-token', {})
      expect(res.status).toBe(200)
    } finally {
      await rest.close()
    }
  })

  // THE REGRESSION FIX: a loopback caller on an auth-ENFORCING hub must present a
  // bearer like anyone else — the old unconditional loopback bypass is exactly
  // what a reverse proxy in front of a standalone hub turns into "anyone reaches
  // this route". Bootstrap-owner (hub.owner.json) is what keeps an on-box caller
  // working without operator action; this is asserted from the CLI side, not
  // here — this test asserts the SERVER no longer trusts the peer alone.
  test('loopback caller on an auth-enforcing hub MUST present a bearer', async () => {
    let verifyCalls = 0
    const rest = await mount(boundComputers, {
      required: () => true,
      verifyBearer: async () => {
        verifyCalls += 1
        return null
      }
    })
    try {
      const res = await rest.request<{ error: string }>('POST', '/api/computers/join-token', {})
      expect(res.status).toBe(401)
      expect(verifyCalls).toBe(1)
    } finally {
      await rest.close()
    }
  })

  test('loopback caller on an auth-enforcing hub mints WITH a valid bearer', async () => {
    const rest = await mount(boundComputers, {
      required: () => true,
      verifyBearer: async () => ({ userId: 'u1', scopes: ['full'] })
    })
    try {
      const res = await rest.request<{ token: string }>('POST', '/api/computers/join-token', {})
      expect(res.status).toBe(200)
    } finally {
      await rest.close()
    }
  })

  test('loopback caller on an auth-enforcing hub is REFUSED with a scoped (non-full) bearer', async () => {
    // A szw_ web session must not be able to mint a computer join token even
    // though it presents a genuinely valid credential — join-token.ts checks
    // for `full` specifically, not merely "verifyBearer resolved something".
    const rest = await mount(boundComputers, {
      required: () => true,
      verifyBearer: async () => ({ userId: 'u2', scopes: ['read', 'tasks'] })
    })
    try {
      const res = await rest.request<{ error: string }>('POST', '/api/computers/join-token', {})
      expect(res.status).toBe(401)
    } finally {
      await rest.close()
    }
  })
})

/**
 * WHO MAY MINT — the pure decision, exhaustively.
 *
 * The 403/401 exists because a join token is a bearer-equivalent secret. On an
 * auth-enforcing hub a valid session ALREADY grants the identical operation over
 * `/trpc` (`computers.mintJoinToken` is not loopback-gated), so refusing an
 * off-box session here was a capability gap between two transports, not a
 * boundary — but an unconditional loopback bypass was a REAL boundary, and one a
 * reverse proxy silently erases. Loopback is authoritative ONLY when there is no
 * auth to check at all.
 */
await describe('joinTokenAuthDecision', () => {
  test('auth NOT required (supervised): loopback mints, off-box is forbidden', () => {
    expect(joinTokenAuthDecision({ loopback: true, authRequired: false, bearerOk: false })).toBe(
      'mint'
    )
    expect(joinTokenAuthDecision({ loopback: false, authRequired: false, bearerOk: false })).toBe(
      'forbid'
    )
  })

  test('auth REQUIRED: loopback is NOT special — a bearer is required either way', () => {
    // THE REGRESSION MATRIX. A loopback peer on an enforcing hub gets exactly the
    // same answer an off-box peer would: verified bearer mints, missing/invalid
    // is 401. This is the fix — the old function returned 'mint' unconditionally
    // for loopback regardless of `authRequired`.
    expect(joinTokenAuthDecision({ loopback: true, authRequired: true, bearerOk: true })).toBe(
      'mint'
    )
    expect(joinTokenAuthDecision({ loopback: true, authRequired: true, bearerOk: false })).toBe(
      'unauthorized'
    )
  })

  test('off-box on a hub that does NOT enforce auth: 403, unchanged', () => {
    // A local-mode hub has no sessions to verify, so a bearer would be
    // unverifiable — accepting one would be security theater. Being on the box
    // stays the only authority here.
    expect(joinTokenAuthDecision({ loopback: false, authRequired: false, bearerOk: false })).toBe(
      'forbid'
    )
    expect(joinTokenAuthDecision({ loopback: false, authRequired: false, bearerOk: true })).toBe(
      'forbid'
    )
  })

  test('off-box on an enforcing hub: valid bearer mints, missing/invalid is 401', () => {
    expect(joinTokenAuthDecision({ loopback: false, authRequired: true, bearerOk: true })).toBe(
      'mint'
    )
    // 401, not 403: the caller has a credential problem (fixable by signing in),
    // not a policy one (fixable only by moving to the hub's machine).
    expect(joinTokenAuthDecision({ loopback: false, authRequired: true, bearerOk: false })).toBe(
      'unauthorized'
    )
  })
})

// Exported so the peer classification is asserted directly — the harness binds
// 127.0.0.1, so no request it can make is ever off-box.
await describe('isLoopbackAddress', () => {
  test('accepts every loopback form node reports', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.0.0.53')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  test('rejects off-box and unknown peers', () => {
    expect(isLoopbackAddress('10.0.0.5')).toBe(false)
    expect(isLoopbackAddress('203.0.113.9')).toBe(false)
    // Unknown peer must fail CLOSED — an absent address is not a loopback proof.
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

h.cleanup()
