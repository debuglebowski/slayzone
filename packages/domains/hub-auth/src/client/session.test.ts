/** Who a bearer belongs to (`/api/auth/get-session`). */
import { describe, expect, it } from 'vitest'
import { fakeHubTransport } from './fake-hub-transport'
import { checkHubSession, fetchSessionEmail } from './session'

const BASE = 'https://hub.example.com'

describe('fetchSessionEmail', () => {
  it('GETs the session with the bearer and answers the email', async () => {
    const hub = fakeHubTransport(() => ({
      status: 200,
      body: { user: { email: 'ada@example.com' }, session: {} }
    }))
    expect(await fetchSessionEmail(hub.transport, BASE, 'tok')).toBe('ada@example.com')
    expect(hub.requests).toEqual([
      {
        method: 'GET',
        url: 'https://hub.example.com/api/auth/get-session',
        headers: { authorization: 'Bearer tok' },
        timeoutMs: 10000,
        maxResponseChars: 65536
      }
    ])
  })

  it('null when there is no email, no session, no JSON, or no answer', async () => {
    for (const body of [{ user: {} }, 'null', '<html>', { user: { email: 3 } }]) {
      const hub = fakeHubTransport(() => ({ status: 200, body }))
      expect(await fetchSessionEmail(hub.transport, BASE, 'tok')).toBeNull()
    }
    const down = fakeHubTransport(() => new Error('ECONNREFUSED'))
    expect(await fetchSessionEmail(down.transport, BASE, 'tok')).toBeNull()
  })
})

describe('checkHubSession', () => {
  it('valid: the hub names the account', async () => {
    const hub = fakeHubTransport(() => ({ status: 200, body: { user: { email: 'ada@x.com' } } }))
    expect(await checkHubSession(hub.transport, BASE, 'tok')).toEqual({
      state: 'valid',
      email: 'ada@x.com'
    })
  })
  it('expired: the hub answered, and knows no session for the token', async () => {
    for (const r of [
      { status: 200, body: 'null' },
      { status: 200, body: {} },
      { status: 401, body: {} }
    ]) {
      const hub = fakeHubTransport(() => r)
      expect(await checkHubSession(hub.transport, BASE, 'tok')).toEqual({ state: 'expired' })
    }
  })
  it('unreachable: no answer, or not one about the session', async () => {
    const down = fakeHubTransport(() => new Error('ECONNREFUSED'))
    expect(await checkHubSession(down.transport, BASE, 'tok')).toEqual({ state: 'unreachable' })
    for (const r of [
      { status: 502, body: '<html>' },
      { status: 200, body: '<html>' }
    ]) {
      const hub = fakeHubTransport(() => r)
      expect(await checkHubSession(hub.transport, BASE, 'tok')).toEqual({ state: 'unreachable' })
    }
  })
})
