/**
 * "Sign in with Microsoft" as the app runs it, with the hub, the auth session and the
 * keychain faked at the edges: what each outcome tells the person, and that only a
 * completed exchange is kept.
 */
import { createHash, webcrypto } from 'node:crypto'
import type { HubHttpRequest, HubTransport, PkceCrypto } from '@slayzone/hub-auth/client'
import { hubEntryOf, type HubSession } from '../hub-session'
import { type AuthSessionResult, signInWithMicrosoft } from './microsoft-sign-in'

const nodeCrypto: PkceCrypto = {
  getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
  sha256: (data) => webcrypto.subtle.digest('SHA-256', data)
}

const HEALTH = { ok: true, authRequired: true, appSignIn: { microsoft: true } }

/** A hub: `/health` and the token route, answered by `answer`. */
function fakeHub(answer: (req: HubHttpRequest) => { status: number; body: unknown } | Error) {
  const requests: HubHttpRequest[] = []
  const transport: HubTransport = async (req) => {
    requests.push(req)
    const a = answer(req)
    if (a instanceof Error) throw a
    return { status: a.status, header: () => null, text: JSON.stringify(a.body) }
  }
  return { transport, requests }
}

const hubAnswering = (token: { status: number; body: unknown } | Error) =>
  fakeHub((req) => (req.url.endsWith('/health') ? { status: 200, body: HEALTH } : token))

/** The auth session: echoes the start URL's state into `query` (or answers `result`). */
function authSession(answer: (start: URL) => AuthSessionResult | Promise<AuthSessionResult>): {
  open: jest.Mock
  opened: () => URL
} {
  let last: URL | null = null
  const open = jest.fn(async (url: string) => {
    last = new URL(url)
    return answer(last)
  })
  return { open, opened: () => last! }
}

const returning = (query: (state: string) => string) =>
  authSession((start) => ({
    type: 'success',
    url: `slayzone://auth/callback?${query(start.searchParams.get('state')!)}`
  }))

function run(
  hub: ReturnType<typeof fakeHub>,
  session: ReturnType<typeof authSession>,
  address = 'hub.example.com'
) {
  const saved: HubSession[] = []
  const result = signInWithMicrosoft(address, {
    crypto: nodeCrypto,
    openAuthSession: session.open,
    transport: hub.transport,
    sessions: { save: async (s) => void saved.push(s) }
  })
  return { result, saved }
}

describe('signInWithMicrosoft', () => {
  it('signs in: the hub start URL in the auth session, the code exchanged with the verifier, the token kept', async () => {
    const hub = hubAnswering({ status: 200, body: { token: 'tok' } })
    const session = returning((state) => `code=${'c'.repeat(43)}&state=${state}`)
    const { result, saved } = run(hub, session)
    const out = await result
    const session0: HubSession = { entry: hubEntryOf('hub.example.com'), token: 'tok' }
    expect(out).toEqual({ ok: true, session: session0 })
    expect(saved).toEqual([session0])

    const start = session.opened()
    expect(`${start.origin}${start.pathname}`).toBe('https://hub.example.com/api/auth/app-sso')
    expect(session.open).toHaveBeenCalledWith(expect.any(String), 'slayzone://auth/callback')
    const exchange = hub.requests.find((r) => r.url.endsWith('/api/auth/app-sso/token'))!
    const body = JSON.parse(exchange.body!) as { code: string; code_verifier: string }
    expect(body.code).toBe('c'.repeat(43))
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(
      start.searchParams.get('code_challenge')
    )
  })

  it('a loopback hub is reached over http', async () => {
    const hub = hubAnswering({ status: 200, body: { token: 'tok' } })
    const session = returning((state) => `code=${'c'.repeat(43)}&state=${state}`)
    await run(hub, session, '127.0.0.1:8788').result
    expect(session.opened().origin).toBe('http://127.0.0.1:8788')
  })

  it('cancelled in the sheet: says so, keeps nothing, never exchanges', async () => {
    for (const type of ['cancel', 'dismiss'] as const) {
      const hub = hubAnswering({ status: 200, body: { token: 'tok' } })
      const { result, saved } = run(
        hub,
        authSession(() => ({ type }))
      )
      expect(await result).toEqual({ ok: false, error: 'Sign-in was cancelled.' })
      expect(saved).toEqual([])
      expect(hub.requests.some((r) => r.url.endsWith('/token'))).toBe(false)
    }
  })

  it('another sign-in sheet already open', async () => {
    const hub = hubAnswering({ status: 200, body: {} })
    const { result } = run(
      hub,
      authSession(() => ({ type: 'locked' }))
    )
    expect(await result).toMatchObject({
      ok: false,
      error: expect.stringContaining('already open')
    })
  })

  it('the auth session failing to open is an error, not a crash', async () => {
    const hub = hubAnswering({ status: 200, body: {} })
    const { result } = run(
      hub,
      authSession(() => {
        throw new Error('no window')
      })
    )
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('no window') })
  })

  it('refused by Microsoft for this hub (tenant, role, MFA): the shared message', async () => {
    const hub = hubAnswering({ status: 200, body: {} })
    const { result, saved } = run(
      hub,
      returning((state) => `error=unable_to_get_user_info&state=${state}`)
    )
    const out = await result
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('Microsoft refused this account for this hub')
    expect(saved).toEqual([])
  })

  it('cancelled on the hub page: access_denied', async () => {
    const hub = hubAnswering({ status: 200, body: {} })
    const { result } = run(
      hub,
      returning((state) => `error=access_denied&state=${state}`)
    )
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
  })

  it("an answer for another sign-in (someone else's state) is not used", async () => {
    const hub = hubAnswering({ status: 200, body: { token: 'tok' } })
    const { result, saved } = run(
      hub,
      returning(() => `code=${'c'.repeat(43)}&state=other`)
    )
    expect(await result).toMatchObject({
      ok: false,
      error: expect.stringContaining('did not match')
    })
    expect(saved).toEqual([])
    expect(hub.requests.some((r) => r.url.endsWith('/token'))).toBe(false)
  })

  it('the code expired before the exchange', async () => {
    const hub = hubAnswering({
      status: 400,
      body: { error: 'invalid_grant', code: 'CODE_EXPIRED' }
    })
    const { result } = run(
      hub,
      returning((state) => `code=${'c'.repeat(43)}&state=${state}`)
    )
    expect(await result).toEqual({
      ok: false,
      error: 'The sign-in took too long to finish. Try again.'
    })
  })

  it('the account was disabled before the exchange', async () => {
    const hub = hubAnswering({
      status: 403,
      body: { error: 'access_denied', code: 'ACCOUNT_DISABLED' }
    })
    const { result } = run(
      hub,
      returning((state) => `code=${'c'.repeat(43)}&state=${state}`)
    )
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('disabled') })
  })

  it('any other refusal of the code', async () => {
    const hub = hubAnswering({
      status: 400,
      body: { error: 'invalid_grant', code: 'CODE_INVALID' }
    })
    const { result } = run(
      hub,
      returning((state) => `code=${'c'.repeat(43)}&state=${state}`)
    )
    expect(await result).toEqual({ ok: false, error: 'The hub refused the sign-in. Try again.' })
  })

  it('the hub unreachable before the sheet opens', async () => {
    const hub = fakeHub(() => new Error('Network request failed'))
    const session = authSession(() => ({ type: 'cancel' }))
    const { result } = run(hub, session)
    expect(await result).toEqual({
      ok: false,
      error: 'Could not reach the hub: Network request failed'
    })
    expect(session.open).not.toHaveBeenCalled()
  })

  it('the hub unreachable at the exchange', async () => {
    const hub = hubAnswering(new Error('Network request failed'))
    const { result } = run(
      hub,
      returning((state) => `code=${'c'.repeat(43)}&state=${state}`)
    )
    expect(await result).toEqual({
      ok: false,
      error: 'Could not reach the hub: Network request failed'
    })
  })

  it('a hub that does not offer it (an older hub with SSO on, or none)', async () => {
    const hub = fakeHub(() => ({
      status: 200,
      body: { ok: true, switches: { enableSso: true, requireLogin: true } }
    }))
    const session = authSession(() => ({ type: 'cancel' }))
    expect(await run(hub, session).result).toEqual({
      ok: false,
      error: 'This hub does not offer Microsoft sign-in'
    })
    expect(session.open).not.toHaveBeenCalled()
  })

  it('a malformed hub address', async () => {
    const hub = hubAnswering({ status: 200, body: {} })
    expect(
      await run(
        hub,
        authSession(() => ({ type: 'cancel' })),
        'https://x/'
      ).result
    ).toEqual({
      ok: false,
      error: 'Enter the hub as host or host:port'
    })
  })
})
