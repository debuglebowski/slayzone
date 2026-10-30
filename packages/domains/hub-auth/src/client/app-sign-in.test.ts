/** App sign-in through Microsoft (native apps): PKCE, the start URL, the callback, the exchange. */
import { createHash, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  APP_SIGN_IN_PATHS,
  APP_SIGN_IN_REDIRECT_URI,
  appSignInOf,
  base64UrlEncode,
  createPkcePair,
  exchangeAppSignInCode,
  type PkceCrypto,
  pkceS256Challenge,
  readAppSignInCallback,
  startAppSignIn
} from './app-sign-in'
import { fakeHubTransport } from './fake-hub-transport'
import { healthProbeOf } from './health'
import { HubTransportTimeoutError } from './transport'

const BASE = 'https://hub.example.com'

const nodeCrypto: PkceCrypto = {
  getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
  sha256: (data) => webcrypto.subtle.digest('SHA-256', data)
}

/** Predictable "random" bytes: 0, 1, 2, … running on across calls. */
let counter = 0
const countingCrypto: PkceCrypto = {
  getRandomValues: (bytes) => {
    bytes.forEach((_, i) => {
      bytes[i] = counter++ % 256
    })
    return bytes
  },
  sha256: nodeCrypto.sha256
}

const UNRESERVED = /^[A-Za-z0-9._~-]+$/

describe('PKCE (RFC 7636, S256)', () => {
  it('matches the RFC 7636 Appendix B example', async () => {
    expect(await pkceS256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', nodeCrypto)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })

  it('base64url without padding, every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = webcrypto.getRandomValues(new Uint8Array(n))
      expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
    }
  })

  it('a pair: a 43-character verifier from 32 random bytes, its S256 challenge', async () => {
    const { verifier, challenge } = await createPkcePair(nodeCrypto)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('two pairs differ', async () => {
    const a = await createPkcePair(nodeCrypto)
    const b = await createPkcePair(nodeCrypto)
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe('startAppSignIn', () => {
  it("builds the hub's start URL with the challenge, S256, the state and the app's redirect", async () => {
    const pending = await startAppSignIn(BASE, countingCrypto)
    const url = new URL(pending.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}${APP_SIGN_IN_PATHS.start}`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: APP_SIGN_IN_REDIRECT_URI,
      code_challenge: await pkceS256Challenge(pending.verifier, nodeCrypto),
      code_challenge_method: 'S256',
      state: pending.state
    })
    expect(pending.redirectUri).toBe('slayzone://auth/callback')
    expect(pending.state).toMatch(UNRESERVED)
    expect(pending.state.length).toBeGreaterThanOrEqual(43)
    expect(pending.state).not.toBe(pending.verifier)
  })

  it('keeps a path prefix of the base URL', async () => {
    const pending = await startAppSignIn('https://example.com/hub', nodeCrypto)
    expect(pending.url.startsWith('https://example.com/hub/api/auth/app-sso?')).toBe(true)
  })
})

describe('readAppSignInCallback', () => {
  const pending = { state: 'state-abcdefghijklmnop', redirectUri: APP_SIGN_IN_REDIRECT_URI }

  it('the code, when the state is ours', () => {
    expect(
      readAppSignInCallback(
        'slayzone://auth/callback?code=abc_DEF-123&state=state-abcdefghijklmnop',
        pending
      )
    ).toEqual({ ok: true, code: 'abc_DEF-123' })
  })

  it('a code with another state is refused (not ours)', () => {
    const r = readAppSignInCallback('slayzone://auth/callback?code=abc&state=other', pending)
    expect(r).toMatchObject({ ok: false, reason: 'mismatch' })
  })

  it('a code without a state is refused', () => {
    expect(readAppSignInCallback('slayzone://auth/callback?code=abc', pending)).toMatchObject({
      ok: false,
      reason: 'mismatch'
    })
  })

  it('another redirect target is refused', () => {
    for (const url of [
      'slayzone://auth/callbackx?code=abc&state=state-abcdefghijklmnop',
      'evil://auth/callback?code=abc&state=state-abcdefghijklmnop',
      'https://hub.example.com/?code=abc&state=state-abcdefghijklmnop'
    ]) {
      expect(readAppSignInCallback(url, pending), url).toMatchObject({
        ok: false,
        reason: 'mismatch'
      })
    }
  })

  it('an error: refused, with the code and its fixed message (never the description)', () => {
    const r = readAppSignInCallback(
      'slayzone://auth/callback?error=unable_to_get_user_info&error_description=evil%20text&state=state-abcdefghijklmnop',
      pending
    )
    expect(r).toMatchObject({ ok: false, reason: 'refused', code: 'unable_to_get_user_info' })
    if (r.ok) throw new Error('unreachable')
    expect(r.message).toContain('Microsoft refused this account')
    expect(r.message).not.toContain('evil')
  })

  it('an error the hub sent without a state (the flow was lost) is still shown', () => {
    expect(
      readAppSignInCallback('slayzone://auth/callback?error=flow_expired', pending)
    ).toMatchObject({ ok: false, reason: 'refused', code: 'flow_expired' })
  })

  it("an error with someone else's state is a mismatch", () => {
    expect(
      readAppSignInCallback('slayzone://auth/callback?error=access_denied&state=x', pending)
    ).toMatchObject({ ok: false, reason: 'mismatch' })
  })

  it('a code that is not a plain code is unknown', () => {
    expect(
      readAppSignInCallback(
        'slayzone://auth/callback?error=%3Cscript%3E&state=state-abcdefghijklmnop',
        pending
      )
    ).toMatchObject({ ok: false, reason: 'refused', code: 'unknown' })
  })

  it('neither code nor error is a mismatch', () => {
    expect(
      readAppSignInCallback('slayzone://auth/callback?state=state-abcdefghijklmnop', pending)
    ).toMatchObject({ ok: false, reason: 'mismatch' })
  })
})

describe('exchangeAppSignInCode', () => {
  const input = {
    code: 'the-code',
    verifier: 'the-verifier',
    redirectUri: APP_SIGN_IN_REDIRECT_URI
  }

  it('POSTs code, verifier and redirect as JSON to the token route and takes the token', async () => {
    const hub = fakeHubTransport(() => ({ status: 200, body: { token: 'session-token' } }))
    expect(await exchangeAppSignInCode(hub.transport, BASE, input)).toEqual({
      ok: true,
      token: 'session-token'
    })
    expect(hub.requests).toEqual([
      {
        method: 'POST',
        url: 'https://hub.example.com/api/auth/app-sso/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 'the-code',
          code_verifier: 'the-verifier',
          redirect_uri: 'slayzone://auth/callback'
        }),
        timeoutMs: 10000,
        maxResponseChars: 65536
      }
    ])
  })

  it('an expired code: expired', async () => {
    const hub = fakeHubTransport(() => ({
      status: 400,
      body: { error: 'invalid_grant', code: 'CODE_EXPIRED' }
    }))
    expect(await exchangeAppSignInCode(hub.transport, BASE, input)).toMatchObject({
      ok: false,
      reason: 'expired',
      status: 400,
      code: 'CODE_EXPIRED'
    })
  })

  it('any other refusal: refused, with the code', async () => {
    const hub = fakeHubTransport(() => ({
      status: 403,
      body: { error: 'access_denied', code: 'ACCOUNT_DISABLED' }
    }))
    expect(await exchangeAppSignInCode(hub.transport, BASE, input)).toMatchObject({
      ok: false,
      reason: 'refused',
      status: 403,
      code: 'ACCOUNT_DISABLED'
    })
  })

  it('accepted but no token', async () => {
    const hub = fakeHubTransport(() => ({ status: 200, body: {} }))
    expect(await exchangeAppSignInCode(hub.transport, BASE, input)).toMatchObject({
      ok: false,
      reason: 'no-token'
    })
  })

  it('unreachable and timeout', async () => {
    const down = fakeHubTransport(() => new Error('connect ECONNREFUSED'))
    expect(await exchangeAppSignInCode(down.transport, BASE, input)).toMatchObject({
      ok: false,
      reason: 'unreachable'
    })
    const slow = fakeHubTransport(() => new HubTransportTimeoutError(10))
    expect(await exchangeAppSignInCode(slow.transport, BASE, input)).toMatchObject({
      ok: false,
      reason: 'timeout'
    })
  })
})

describe('does the hub offer app sign-in with Microsoft? (/health)', () => {
  it('only when the hub says so', () => {
    expect(appSignInOf({ ok: true, appSignIn: { microsoft: true } })).toEqual({ microsoft: true })
    expect(appSignInOf({ ok: true, appSignIn: { microsoft: false } })).toEqual({ microsoft: false })
    // An older hub: SSO switches on, but no app route → no button.
    expect(appSignInOf({ ok: true, switches: { enableSso: true, requireLogin: true } })).toEqual({
      microsoft: false
    })
    expect(appSignInOf(undefined)).toEqual({ microsoft: false })
    expect(appSignInOf({ appSignIn: { microsoft: 'yes' } })).toEqual({ microsoft: false })
  })

  it('the strict probe carries it when the hub reports it (and only then: older answers stay as they were)', () => {
    expect(healthProbeOf(200, { ok: true, appSignIn: { microsoft: true } })).toEqual({
      ok: true,
      authRequired: undefined,
      signIn: undefined,
      appSignIn: { microsoft: true }
    })
    expect(healthProbeOf(200, { ok: true })).toEqual({
      ok: true,
      authRequired: undefined,
      signIn: undefined
    })
  })
})
