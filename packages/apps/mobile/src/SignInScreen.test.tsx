/**
 * The sign-in screen against faked edges: the hub (`fetch`), iOS's auth session
 * (`expo-web-browser`), PKCE hashing (`expo-crypto`, Node's WebCrypto here) and the
 * keychain (`expo-secure-store`). "Sign in with Microsoft" shows only where the hub
 * offers it; each way the sign-in ends says what happened.
 */
import { render, screen, userEvent, waitFor } from '@testing-library/react-native'
import * as WebBrowser from 'expo-web-browser'
import { hubEntryOf, type HubSession } from './hub-session'
import { SignInScreen } from './SignInScreen'

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }))
jest.mock('expo-crypto', () => {
  const { webcrypto } = jest.requireActual<typeof import('node:crypto')>('node:crypto')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    getRandomValues: (bytes: Uint8Array) => webcrypto.getRandomValues(bytes),
    digest: (_algorithm: string, data: Uint8Array) => webcrypto.subtle.digest('SHA-256', data)
  }
})
const mockKeychain = new Map<string, string>()
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mockKeychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void mockKeychain.set(key, value),
  deleteItemAsync: async (key: string) => void mockKeychain.delete(key)
}))

const openAuthSession = WebBrowser.openAuthSessionAsync as jest.Mock

/** `/health` per hub host; a host not listed is unreachable. */
const HUBS: Record<string, unknown> = {
  'sso.example.com': {
    ok: true,
    authRequired: true,
    switches: { requireLogin: true, enableSso: true, enablePassword: false },
    appSignIn: { microsoft: true }
  },
  'both.example.com': {
    ok: true,
    authRequired: true,
    switches: { requireLogin: true, enableSso: true, enablePassword: true },
    appSignIn: { microsoft: true }
  },
  'pw.example.com': {
    ok: true,
    authRequired: true,
    switches: { requireLogin: true, enableSso: false, enablePassword: true },
    appSignIn: { microsoft: false }
  }
}

let tokenAnswer: { status: number; body: unknown }
let healthCalls = 0

beforeEach(() => {
  mockKeychain.clear()
  openAuthSession.mockReset()
  healthCalls = 0
  tokenAnswer = { status: 200, body: { token: 'the-token' } }
  global.fetch = jest.fn(async (input: string) => {
    const url = new URL(input)
    const answer = (status: number, body: unknown) => ({
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    })
    if (url.pathname === '/health') {
      healthCalls++
      const health = HUBS[url.host]
      if (!health) throw new TypeError('Network request failed')
      return answer(200, health)
    }
    if (url.pathname === '/api/auth/app-sso/token')
      return answer(tokenAnswer.status, tokenAnswer.body)
    return answer(404, {})
  }) as unknown as typeof fetch
})

/** The auth session ends on the app redirect with `query(state)`. */
function sessionReturns(query: (state: string) => string): void {
  openAuthSession.mockImplementation(async (url: string) => {
    const state = new URL(url).searchParams.get('state') ?? ''
    return { type: 'success', url: `slayzone://auth/callback?${query(state)}` }
  })
}

async function typeHub(address: string) {
  const onSignedIn = jest.fn<void, [HubSession]>()
  await render(<SignInScreen title="Sign in to a hub" onSignedIn={onSignedIn} />)
  const user = userEvent.setup()
  await user.type(screen.getByPlaceholderText('hub.example.com or 127.0.0.1:8788'), address)
  return { onSignedIn, user }
}

describe('SignInScreen: Sign in with Microsoft', () => {
  it('a hub that offers it: the button; success keeps the token like a password sign-in', async () => {
    sessionReturns((state) => `code=${'c'.repeat(43)}&state=${state}`)
    const { onSignedIn, user } = await typeHub('both.example.com')
    await user.press(await screen.findByText('Sign in with Microsoft'))

    const session: HubSession = { entry: hubEntryOf('both.example.com'), token: 'the-token' }
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(session))
    expect(openAuthSession).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/both\.example\.com\/api\/auth\/app-sso\?/),
      'slayzone://auth/callback',
      { preferEphemeralSession: false }
    )
    expect([...mockKeychain.values()]).toContain('the-token')
    // The password form stays for a hub that offers both.
    expect(screen.getByText('Password')).toBeOnTheScreen()
  })

  it('a password-only hub: no Microsoft button, the password form as before', async () => {
    await typeHub('pw.example.com')
    await waitFor(() => expect(healthCalls).toBeGreaterThan(0))
    await waitFor(() => expect(screen.queryByText('Sign in with Microsoft')).toBeNull())
    expect(screen.getByText('Email')).toBeOnTheScreen()
    expect(screen.getByText('Password')).toBeOnTheScreen()
  })

  it('a hub with password sign-in off shows only Microsoft', async () => {
    await typeHub('sso.example.com')
    expect(await screen.findByText('Sign in with Microsoft')).toBeOnTheScreen()
    expect(screen.queryByText('Password')).toBeNull()
    expect(screen.queryByText('Email')).toBeNull()
  })

  it('cancelled in the sheet', async () => {
    openAuthSession.mockResolvedValue({ type: 'cancel' })
    const { onSignedIn, user } = await typeHub('sso.example.com')
    await user.press(await screen.findByText('Sign in with Microsoft'))
    expect(await screen.findByText('Sign-in was cancelled.')).toBeOnTheScreen()
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(mockKeychain.size).toBe(0)
  })

  it('refused by the tenant or role (Microsoft refused the account for this hub)', async () => {
    sessionReturns((state) => `error=unable_to_get_user_info&state=${state}`)
    const { onSignedIn, user } = await typeHub('sso.example.com')
    await user.press(await screen.findByText('Sign in with Microsoft'))
    expect(await screen.findByText(/Microsoft refused this account for this hub/)).toBeOnTheScreen()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('the code expired before the exchange', async () => {
    sessionReturns((state) => `code=${'c'.repeat(43)}&state=${state}`)
    tokenAnswer = { status: 400, body: { error: 'invalid_grant', code: 'CODE_EXPIRED' } }
    const { onSignedIn, user } = await typeHub('sso.example.com')
    await user.press(await screen.findByText('Sign in with Microsoft'))
    expect(
      await screen.findByText('The sign-in took too long to finish. Try again.')
    ).toBeOnTheScreen()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('the hub unreachable when pressed', async () => {
    const { user } = await typeHub('sso.example.com')
    const button = await screen.findByText('Sign in with Microsoft')
    delete HUBS['sso.example.com'] // goes away between the probe and the press
    try {
      await user.press(button)
      expect(await screen.findByText(/^Could not reach the hub: /)).toBeOnTheScreen()
      expect(openAuthSession).not.toHaveBeenCalled()
    } finally {
      HUBS['sso.example.com'] = {
        ok: true,
        authRequired: true,
        switches: { requireLogin: true, enableSso: true, enablePassword: false },
        appSignIn: { microsoft: true }
      }
    }
  })

  it('an unreachable hub: no button, the password form stays (as before)', async () => {
    await typeHub('down.example.com')
    await waitFor(() => expect(healthCalls).toBeGreaterThan(0))
    expect(screen.queryByText('Sign in with Microsoft')).toBeNull()
    expect(screen.getByText('Password')).toBeOnTheScreen()
  })
})
