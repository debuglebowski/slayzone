/**
 * `/health` readings: the desktop probe (strict), the native sign-in methods (any body),
 * and the web shell's browser reading (fails closed).
 */
import { describe, expect, it } from 'vitest'
import { fakeHubTransport } from './fake-hub-transport'
import {
  fetchHubHealth,
  healthProbeOf,
  HUB_BROWSER_SIGN_IN_UNKNOWN,
  hubBrowserSignInOf,
  probeHubHealth,
  signInMethodsOf
} from './health'
import { HubTransportTimeoutError } from './transport'

const BASE = 'https://hub.example.com'

describe('fetchHubHealth', () => {
  it('GETs <base>/health with no headers, capped at 4 KiB', async () => {
    const hub = fakeHubTransport(() => ({ status: 200, body: { ok: true } }))
    expect(await fetchHubHealth(hub.transport, BASE, 1234)).toEqual({
      reachable: true,
      status: 200,
      json: { ok: true }
    })
    expect(hub.requests).toEqual([
      {
        method: 'GET',
        url: 'https://hub.example.com/health',
        headers: {},
        timeoutMs: 1234,
        maxResponseChars: 4096
      }
    ])
  })

  it('keeps a base path prefix', async () => {
    const hub = fakeHubTransport(() => ({ status: 200, body: {} }))
    await fetchHubHealth(hub.transport, 'https://example.com/hub', 1000)
    expect(hub.requests[0]!.url).toBe('https://example.com/hub/health')
  })

  it('any status is reachable; a body that is not JSON reads as undefined', async () => {
    const hub = fakeHubTransport(() => ({ status: 502, body: '<html>bad gateway</html>' }))
    expect(await fetchHubHealth(hub.transport, BASE, 1000)).toEqual({
      reachable: true,
      status: 502,
      json: undefined
    })
  })

  it('unreachable: the transport error; timeout: the health-check wording', async () => {
    const down = fakeHubTransport(() => new Error('connect ECONNREFUSED 127.0.0.1:1'))
    expect(await fetchHubHealth(down.transport, BASE, 1000)).toEqual({
      reachable: false,
      reason: 'unreachable',
      error: 'connect ECONNREFUSED 127.0.0.1:1'
    })
    const wedged = fakeHubTransport(() => new HubTransportTimeoutError(200))
    expect(await fetchHubHealth(wedged.transport, BASE, 200)).toEqual({
      reachable: false,
      reason: 'timeout',
      error: 'Health check timed out after 200ms'
    })
  })
})

describe('healthProbeOf / probeHubHealth (desktop add-hub probe)', () => {
  it('200 {ok:true}: ok, with authRequired and sign-in methods when reported', () => {
    expect(healthProbeOf(200, { ok: true })).toEqual({ ok: true })
    expect(
      healthProbeOf(200, {
        ok: true,
        authRequired: true,
        switches: { enableSso: true, enablePassword: false }
      })
    ).toEqual({ ok: true, authRequired: true, signIn: { sso: true, password: false } })
  })

  it('authRequired that is not a boolean stays unknown (undefined)', () => {
    expect(healthProbeOf(200, { ok: true, authRequired: 'yes' })).toEqual({ ok: true })
  })

  it('non-200: the status', () => {
    expect(healthProbeOf(503, { ok: false })).toEqual({
      ok: false,
      error: 'Server answered HTTP 503'
    })
  })

  it('a body that is not JSON, or JSON null: not a SlayZone server', () => {
    for (const json of [undefined, null]) {
      expect(healthProbeOf(200, json)).toEqual({
        ok: false,
        error: 'Not a SlayZone server (bad /health body)'
      })
    }
  })

  it('not ok: not ready, keeping authRequired', () => {
    expect(healthProbeOf(200, { ok: false, authRequired: false })).toEqual({
      ok: false,
      error: 'Server is not ready',
      authRequired: false
    })
    expect(healthProbeOf(200, 42)).toEqual({ ok: false, error: 'Server is not ready' })
  })

  it('probeHubHealth: read + strict reading; unreachable/timeout carry the read error', async () => {
    const ok = fakeHubTransport(() => ({ status: 200, body: { ok: true, authRequired: false } }))
    expect(await probeHubHealth(ok.transport, BASE)).toEqual({ ok: true, authRequired: false })
    expect(ok.requests[0]!.timeoutMs).toBe(5000)
    const wedged = fakeHubTransport(() => new HubTransportTimeoutError(5000))
    expect(await probeHubHealth(wedged.transport, BASE)).toEqual({
      ok: false,
      error: 'Health check timed out after 5000ms'
    })
  })
})

describe('signInMethodsOf (native clients)', () => {
  it('reads the switches: SSO only when explicitly on, password unless explicitly off', () => {
    expect(signInMethodsOf({ switches: { enableSso: true, enablePassword: false } })).toEqual({
      sso: true,
      password: false
    })
    expect(signInMethodsOf({ switches: { enableSso: 'true' } })).toEqual({
      sso: false,
      password: true
    })
  })

  it('no switches (a hub too old to say, a 503 body, not JSON, null): undefined', () => {
    for (const body of [{ ok: true }, { ok: false, reason: 'starting' }, undefined, null, 7]) {
      expect(signInMethodsOf(body)).toBeUndefined()
    }
  })
})

describe('hubBrowserSignInOf (web shell, FAILS CLOSED)', () => {
  it('authRequired is false only on an explicit authRequired:false', () => {
    expect(hubBrowserSignInOf({ authRequired: false }).authRequired).toBe(false)
    expect(hubBrowserSignInOf({ authRequired: true }).authRequired).toBe(true)
    expect(hubBrowserSignInOf({}).authRequired).toBe(true)
    expect(hubBrowserSignInOf({ authRequired: 'false' }).authRequired).toBe(true)
  })

  it('an Entra hub with password off: Microsoft only (T-13)', () => {
    expect(
      hubBrowserSignInOf({
        authRequired: true,
        switches: { requireLogin: true, enablePassword: false, enableSso: true }
      })
    ).toEqual({ authRequired: true, methods: { password: false, sso: true } })
  })

  it('SSO counts only where login is required (the hub only serves it there)', () => {
    expect(
      hubBrowserSignInOf({
        authRequired: false,
        switches: { requireLogin: false, enablePassword: true, enableSso: true }
      }).methods
    ).toEqual({ password: true, sso: false })
  })

  it('null / no body: the fail-closed answer', () => {
    expect(hubBrowserSignInOf(null)).toEqual(HUB_BROWSER_SIGN_IN_UNKNOWN)
    expect(hubBrowserSignInOf(undefined)).toEqual(HUB_BROWSER_SIGN_IN_UNKNOWN)
    expect(HUB_BROWSER_SIGN_IN_UNKNOWN).toEqual({
      authRequired: true,
      methods: { password: false, sso: false }
    })
  })
})
