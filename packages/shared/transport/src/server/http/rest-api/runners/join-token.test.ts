/**
 * REST: POST /api/runners/join-token contract tests (Wave3.5-D3).
 * Run with the electron+loader runner (better-sqlite3 native ABI via the harness DB).
 *
 * The route is the mint channel the Electron MAIN process hits at boot to
 * auto-enroll its local runner (main has no tRPC client to the sidecar), AND the
 * channel `slay runner mint` uses. It wraps the same store `mintJoinToken` as the
 * runners tRPC proc, gated on the `deps.runners` slot (wired once the runner init
 * resolves):
 *   - runner ON + listener bound  → 200 { token (decodable szjt1), hubUrl (wss) }
 *   - runner ON + not-yet-bound   → 503 (main retries)
 *   - runner OFF (slot absent)    → 503 (never mints; default boot byte-identical)
 *
 * WHO MAY CALL IT is a separate axis, decided by the pure `joinTokenAuthDecision`
 * and asserted at the bottom: loopback always, off-box only on an auth-enforcing
 * hub with a verified bearer. The HTTP harness binds 127.0.0.1, so every peer it
 * can produce is loopback — which is exactly why that decision is a pure exported
 * function rather than reachable through a request (same reasoning as the sibling
 * `hub/users.ts` suite).
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { decodeJoinToken } from '@slayzone/runners/server'
import {
  isLoopbackAddress,
  joinTokenAuthDecision,
  registerRunnersJoinTokenRoute
} from './join-token.js'
import type { RestApiDeps } from '../types.js'

const h = await createTestHarness()

/** A bound runner listener (runner ON, url + fingerprint present). */
const boundRunners = {
  getHubUrl: () => 'wss://127.0.0.1:54321/runners',
  getCertFingerprint: () => 'abcdef0123456789'
}

function mount(runners: RestApiDeps['runners'], restAuth?: RestApiDeps['restAuth']) {
  const app = express()
  app.use(express.json())
  registerRunnersJoinTokenRoute(app, {
    db: h.slayDb,
    notifyRenderer: () => {},
    runners,
    ...(restAuth ? { restAuth } : {})
  })
  return mountRestApp(app)
}

await describe('POST /api/runners/join-token', () => {
  test('runner ON + bound: mints a decodable szjt1 token embedding the wss hub url', async () => {
    const rest = await mount(boundRunners)
    try {
      const res = await rest.request<{ token: string; hubUrl: string }>(
        'POST',
        '/api/runners/join-token',
        { label: 'local-runner' }
      )
      expect(res.status).toBe(200)
      expect(res.body.hubUrl).toBe('wss://127.0.0.1:54321/runners')
      const payload = decodeJoinToken(res.body.token)
      expect(payload).not.toBeNull()
      expect(payload!.hubUrl).toBe('wss://127.0.0.1:54321/runners')
      expect(payload!.certFingerprint).toBe('abcdef0123456789')
    } finally {
      await rest.close()
    }
  })

  test('runner ON but listener not yet bound (null url): 503', async () => {
    const rest = await mount({ getHubUrl: () => null, getCertFingerprint: () => null })
    try {
      const res = await rest.request<{ error: string }>('POST', '/api/runners/join-token', {})
      expect(res.status).toBe(503)
    } finally {
      await rest.close()
    }
  })

  test('runner OFF (runners slot absent): 503, never mints', async () => {
    const rest = await mount(undefined)
    try {
      const res = await rest.request<{ error: string }>('POST', '/api/runners/join-token', {})
      expect(res.status).toBe(503)
    } finally {
      await rest.close()
    }
  })

  test('defaults the label when omitted', async () => {
    const rest = await mount(boundRunners)
    try {
      const res = await rest.request<{ token: string; hubUrl: string }>(
        'POST',
        '/api/runners/join-token',
        {}
      )
      expect(res.status).toBe(200)
      expect(typeof res.body.token).toBe('string')
    } finally {
      await rest.close()
    }
  })

  // A loopback caller must never be asked for a bearer, whatever the gate says —
  // this is the Electron host's boot auto-enroll path and the on-box `slay` path.
  test('loopback caller mints even on an auth-enforcing hub, without a bearer', async () => {
    let verifyCalls = 0
    const rest = await mount(boundRunners, {
      required: () => true,
      verifyBearer: async () => {
        verifyCalls += 1
        return false
      }
    })
    try {
      const res = await rest.request<{ token: string }>('POST', '/api/runners/join-token', {})
      expect(res.status).toBe(200)
      // Not merely "allowed": the bearer must not even be consulted, so a
      // co-located caller can never be broken by an auth-side regression.
      expect(verifyCalls).toBe(0)
    } finally {
      await rest.close()
    }
  })
})

/**
 * WHO MAY MINT — the pure decision, exhaustively.
 *
 * The 403 exists because a join token is a bearer-equivalent secret. But on an
 * auth-enforcing hub a valid session ALREADY grants the identical operation over
 * `/trpc` (`runners.mintJoinToken` is not loopback-gated), so refusing the same
 * caller here was a capability gap between two transports, not a boundary.
 */
await describe('joinTokenAuthDecision', () => {
  test('loopback peer: always mint (gate off or on)', () => {
    expect(
      joinTokenAuthDecision({ loopback: true, authRequired: false, bearerOk: false })
    ).toBe('mint')
    expect(joinTokenAuthDecision({ loopback: true, authRequired: true, bearerOk: false })).toBe(
      'mint'
    )
  })

  test('off-box on a hub that does NOT enforce auth: 403, unchanged', () => {
    // A local-mode hub has no sessions to verify, so a bearer would be
    // unverifiable — accepting one would be security theater. Being on the box
    // stays the only authority here.
    expect(
      joinTokenAuthDecision({ loopback: false, authRequired: false, bearerOk: false })
    ).toBe('forbid')
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
    expect(
      joinTokenAuthDecision({ loopback: false, authRequired: true, bearerOk: false })
    ).toBe('unauthorized')
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
