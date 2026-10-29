/** Email + password sign-in against a fake hub: the request, the token, every refusal. */
import { describe, expect, it } from 'vitest'
import { fakeHubTransport } from './fake-hub-transport'
import { signInWithPassword } from './password'
import { HubTransportTimeoutError } from './transport'

const BASE = 'https://hub.example.com'
const CREDS = { email: 'ada@example.com', password: 'pw' }

describe('signInWithPassword', () => {
  it('POSTs the credentials as JSON to /api/auth/sign-in/email and takes the header token', async () => {
    const hub = fakeHubTransport(() => ({
      status: 200,
      body: { token: 'body-token' },
      headers: { 'Set-Auth-Token': 'header-token' }
    }))
    expect(await signInWithPassword(hub.transport, BASE, CREDS)).toEqual({
      ok: true,
      token: 'header-token'
    })
    expect(hub.requests).toEqual([
      {
        method: 'POST',
        url: 'https://hub.example.com/api/auth/sign-in/email',
        headers: { 'content-type': 'application/json' },
        body: '{"email":"ada@example.com","password":"pw"}',
        timeoutMs: 10000,
        maxResponseChars: 65536
      }
    ])
  })

  it('falls back to a token in the body', async () => {
    const hub = fakeHubTransport(() => ({ status: 200, body: { token: 'body-token' } }))
    expect(await signInWithPassword(hub.transport, BASE, CREDS)).toEqual({
      ok: true,
      token: 'body-token'
    })
  })

  it('HTTP ≥ 400: refused, with the hub code and error text for the caller to explain', async () => {
    const hub = fakeHubTransport(() => ({
      status: 403,
      body: { code: 'HUB_PASSWORD_DISABLED', error: 'Password sign-in is off on this hub.' }
    }))
    expect(await signInWithPassword(hub.transport, BASE, CREDS)).toEqual({
      ok: false,
      reason: 'refused',
      status: 403,
      code: 'HUB_PASSWORD_DISABLED',
      hubError: 'Password sign-in is off on this hub.',
      error: 'Sign-in failed (HTTP 403)'
    })
    const plain = fakeHubTransport(() => ({ status: 401, body: 'nope' }))
    expect(await signInWithPassword(plain.transport, BASE, CREDS)).toEqual({
      ok: false,
      reason: 'refused',
      status: 401,
      error: 'Sign-in failed (HTTP 401)'
    })
  })

  it('accepted without a token: no-token; not JSON and no header: bad-response', async () => {
    for (const body of [{}, { token: '' }, { token: 42 }, 7]) {
      const hub = fakeHubTransport(() => ({ status: 200, body }))
      expect(await signInWithPassword(hub.transport, BASE, CREDS)).toEqual({
        ok: false,
        reason: 'no-token',
        status: 200,
        error: 'Hub returned no token'
      })
    }
    for (const body of ['<html></html>', 'null']) {
      const hub = fakeHubTransport(() => ({ status: 200, body }))
      expect(await signInWithPassword(hub.transport, BASE, CREDS)).toEqual({
        ok: false,
        reason: 'bad-response',
        status: 200,
        error: 'Bad sign-in response'
      })
    }
  })

  it('a 3xx is not a refusal (only ≥ 400 is)', async () => {
    const hub = fakeHubTransport(() => ({ status: 302, body: '' }))
    expect(await signInWithPassword(hub.transport, BASE, CREDS)).toMatchObject({
      ok: false,
      reason: 'bad-response',
      status: 302
    })
  })

  it('unreachable: the transport error; timeout: the sign-in wording', async () => {
    const down = fakeHubTransport(() => new Error('getaddrinfo ENOTFOUND hub.example.com'))
    expect(await signInWithPassword(down.transport, BASE, CREDS)).toEqual({
      ok: false,
      reason: 'unreachable',
      error: 'getaddrinfo ENOTFOUND hub.example.com'
    })
    const wedged = fakeHubTransport(() => new HubTransportTimeoutError(250))
    expect(await signInWithPassword(wedged.transport, BASE, CREDS, 250)).toEqual({
      ok: false,
      reason: 'timeout',
      error: 'Sign-in timed out after 250ms'
    })
  })
})
