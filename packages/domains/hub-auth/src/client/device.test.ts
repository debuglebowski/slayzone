/**
 * Device sign-in (RFC 8628) against a fake hub: the code request, the poll loop's exact
 * semantics (interval, `slow_down`, end states, retries, expiry, cancel), and the page
 * check. The same protocol runs against the real hub in `src/server/device.test.ts`
 * (server side) and apps/hub `hub-device-sign-in.test.ts` (the built CLI).
 */
import { describe, expect, it } from 'vitest'
import { DEVICE_CLIENTS } from '../server/device'
import { isHubOwnPage, requestDeviceCode, waitForDeviceToken } from './device'
import { type FakeAnswer, fakeHubTransport, inOrder } from './fake-hub-transport'
import { HUB_DEVICE_CLIENT_IDS } from './protocol'
import { HubTransportTimeoutError } from './transport'

const BASE = 'https://hub.example.com'
const CODE_REPLY = {
  device_code: 'dev-code',
  user_code: 'ABCDEFGH',
  verification_uri: 'https://hub.example.com/device',
  verification_uri_complete: 'https://hub.example.com/device?user_code=ABCDEFGH',
  expires_in: 600,
  interval: 5
}

describe('client ids', () => {
  it("are exactly the hub's DEVICE_CLIENTS allowlist", () => {
    expect(Object.values(HUB_DEVICE_CLIENT_IDS).sort()).toEqual(Object.keys(DEVICE_CLIENTS).sort())
  })
})

describe('requestDeviceCode', () => {
  it('POSTs the client id to /api/auth/device/code and reads the code', async () => {
    const hub = fakeHubTransport(() => ({ status: 200, body: CODE_REPLY }))
    expect(await requestDeviceCode(hub.transport, BASE, 'slayzone-desktop')).toEqual({
      ok: true,
      deviceCode: 'dev-code',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://hub.example.com/device?user_code=ABCDEFGH',
      expiresInSec: 600,
      intervalSec: 5
    })
    expect(hub.requests).toEqual([
      {
        method: 'POST',
        url: 'https://hub.example.com/api/auth/device/code',
        headers: { 'content-type': 'application/json' },
        body: '{"client_id":"slayzone-desktop"}',
        timeoutMs: 10000,
        maxResponseChars: 65536
      }
    ])
  })

  it('page: the complete URI, else the plain one; interval at least 5s; defaults 600s / 5s', async () => {
    const reply = (body: Record<string, unknown>) =>
      requestDeviceCode(fakeHubTransport(() => ({ status: 200, body })).transport, BASE, 'c')
    expect(
      await reply({ ...CODE_REPLY, verification_uri_complete: '', interval: 2, expires_in: 900 })
    ).toMatchObject({
      verificationUri: 'https://hub.example.com/device',
      intervalSec: 5,
      expiresInSec: 900
    })
    expect(await reply({ ...CODE_REPLY, interval: 12 })).toMatchObject({ intervalSec: 12 })
    expect(
      await reply({ ...CODE_REPLY, interval: '10', expires_in: '60', verification_uri: undefined })
    ).toMatchObject({
      ok: true,
      verificationUri: CODE_REPLY.verification_uri_complete,
      intervalSec: 5,
      expiresInSec: 600
    })
  })

  it('refused: not 200, or no usable code — with the status and any description', async () => {
    const answers: Array<[FakeAnswer, Record<string, unknown>]> = [
      [
        { status: 400, body: { error: 'invalid_client', error_description: 'Unknown client' } },
        {
          status: 400,
          description: 'Unknown client',
          error: 'The hub did not start a sign-in (HTTP 400): Unknown client'
        }
      ],
      [
        { status: 400, body: { error_description: '' } },
        { status: 400, description: '', error: 'The hub did not start a sign-in (HTTP 400)' }
      ],
      [
        { status: 201, body: CODE_REPLY },
        { status: 201, error: 'The hub did not start a sign-in (HTTP 201)' }
      ],
      [
        { status: 200, body: { ...CODE_REPLY, user_code: 12345678 } },
        { status: 200, error: 'The hub did not start a sign-in (HTTP 200)' }
      ],
      [
        { status: 404, body: '<html>Not found</html>' },
        { status: 404, error: 'The hub did not start a sign-in (HTTP 404)' }
      ]
    ]
    for (const [answer, expected] of answers) {
      const hub = fakeHubTransport(() => answer)
      expect(await requestDeviceCode(hub.transport, BASE, 'c')).toEqual({
        ok: false,
        reason: 'refused',
        ...expected
      })
    }
  })

  it('unreachable / timeout: the transport error', async () => {
    const down = fakeHubTransport(() => new Error('connect ECONNREFUSED'))
    expect(await requestDeviceCode(down.transport, BASE, 'c')).toEqual({
      ok: false,
      reason: 'unreachable',
      error: 'connect ECONNREFUSED'
    })
    const wedged = fakeHubTransport(() => new HubTransportTimeoutError(10000))
    expect(await requestDeviceCode(wedged.transport, BASE, 'c')).toEqual({
      ok: false,
      reason: 'timeout',
      error: 'timed out after 10000ms'
    })
  })
})

describe('waitForDeviceToken', () => {
  const CODE = { deviceCode: 'dev-code', expiresInSec: 600, intervalSec: 5 }
  const recorder = () => {
    const sleeps: number[] = []
    return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) }
  }
  const pending: FakeAnswer = { status: 400, body: { error: 'authorization_pending' } }

  it('polls through pending and slow_down to the token (5s, then +5s per slow_down)', async () => {
    const hub = fakeHubTransport(
      inOrder(
        pending,
        { status: 400, body: { error: 'slow_down' } },
        {
          status: 200,
          body: { access_token: 'bearer-1', token_type: 'Bearer' }
        }
      )
    )
    const { sleeps, sleep } = recorder()
    expect(await waitForDeviceToken(hub.transport, BASE, 'slayzone-cli', CODE, { sleep })).toEqual({
      ok: true,
      token: 'bearer-1'
    })
    expect(sleeps).toEqual([5000, 5000, 10000])
    expect(hub.requests.map((r) => r.url)).toEqual(
      Array(3).fill('https://hub.example.com/api/auth/device/token')
    )
    expect(JSON.parse(hub.requests[0]!.body!)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dev-code',
      client_id: 'slayzone-cli'
    })
    expect(hub.requests[0]!.timeoutMs).toBe(10000)
  })

  it('a poll that cannot reach the hub is retried', async () => {
    const hub = fakeHubTransport(
      inOrder(new Error('ECONNRESET'), new HubTransportTimeoutError(10000), {
        status: 200,
        body: { access_token: 'bearer-2' }
      })
    )
    const { sleeps, sleep } = recorder()
    expect(await waitForDeviceToken(hub.transport, BASE, 'c', CODE, { sleep })).toEqual({
      ok: true,
      token: 'bearer-2'
    })
    expect(sleeps).toEqual([5000, 5000, 5000])
  })

  it('each end state comes back with its reason and wording', async () => {
    const cases: Array<[FakeAnswer, Record<string, unknown>]> = [
      [
        { status: 400, body: { error: 'access_denied' } },
        { reason: 'denied', status: 400, error: 'Sign-in was denied in the browser' }
      ],
      [
        { status: 400, body: { error: 'expired_token' } },
        { reason: 'expired', status: 400, error: 'The sign-in code expired' }
      ],
      [
        { status: 403, body: { code: 'ACCOUNT_DISABLED' } },
        { reason: 'disabled', status: 403, error: 'This account is disabled on the hub' }
      ],
      [
        { status: 400, body: { error: 'invalid_grant', error_description: 'bad code' } },
        {
          reason: 'failed',
          status: 400,
          description: 'bad code',
          error: 'Sign-in failed (HTTP 400): bad code'
        }
      ],
      [
        { status: 400, body: { error: 'invalid_grant', error_description: '' } },
        { reason: 'failed', status: 400, description: '', error: 'Sign-in failed (HTTP 400): ' }
      ],
      [
        { status: 500, body: 'null' },
        { reason: 'failed', status: 500, error: 'Sign-in failed (HTTP 500)' }
      ],
      // Only a 200 carries the token.
      [
        { status: 201, body: { access_token: 'early' } },
        { reason: 'failed', status: 201, error: 'Sign-in failed (HTTP 201)' }
      ]
    ]
    for (const [answer, expected] of cases) {
      const hub = fakeHubTransport(inOrder(answer))
      expect(
        await waitForDeviceToken(hub.transport, BASE, 'c', CODE, { sleep: recorder().sleep })
      ).toEqual({ ok: false, ...expected })
    }
  })

  it('stops when cancelled, before polling again', async () => {
    const hub = fakeHubTransport(inOrder())
    expect(
      await waitForDeviceToken(hub.transport, BASE, 'c', CODE, {
        sleep: recorder().sleep,
        signal: { aborted: true }
      })
    ).toEqual({ ok: false, reason: 'cancelled', error: 'Sign-in cancelled' })
    expect(hub.requests).toHaveLength(0)
  })

  it("gives up once the code's lifetime (plus one interval) has passed", async () => {
    let clock = 0
    const sleep = async (ms: number) => {
      clock += ms
    }
    const hub = fakeHubTransport(() => pending)
    expect(
      await waitForDeviceToken(
        hub.transport,
        BASE,
        'c',
        { deviceCode: 'd', expiresInSec: 20, intervalSec: 5 },
        { sleep, now: () => clock }
      )
    ).toEqual({ ok: false, reason: 'expired', error: 'The sign-in code expired' })
    // Polls at 5, 10, 15, 20s; at 20s the loop still runs once more (deadline + interval).
    expect(hub.requests).toHaveLength(5)
  })
})

describe('isHubOwnPage', () => {
  it("only the hub's own host, over http(s)", () => {
    expect(isHubOwnPage(BASE, 'https://hub.example.com/device?user_code=X')).toBe(true)
    expect(isHubOwnPage('http://127.0.0.1:4400', 'http://127.0.0.1:4400/device')).toBe(true)
    expect(isHubOwnPage(BASE, 'https://evil.example/device')).toBe(false)
    expect(isHubOwnPage(BASE, 'https://hub.example.com:8443/device')).toBe(false)
    expect(isHubOwnPage(BASE, 'javascript:alert(1)')).toBe(false)
    expect(isHubOwnPage(BASE, 'not a url')).toBe(false)
    expect(isHubOwnPage('not a url', 'https://hub.example.com/device')).toBe(false)
  })
})
