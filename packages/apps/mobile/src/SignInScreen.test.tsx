/**
 * The sign-in screen against faked edges: the hub (`fetch`), iOS's auth session
 * (`expo-web-browser`), PKCE hashing (`expo-crypto`, Node's WebCrypto here) and the
 * keychain (`expo-secure-store`). "Sign in with Microsoft" shows only where the hub
 * offers it; each way the sign-in ends says what happened.
 */
import { act, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import { AccessibilityInfo } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { cantReachHub, hubEntryOf, type HubSession } from './hub-session'
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
  await user.type(screen.getByPlaceholderText('hub.yourcompany.com'), address)
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

  it('cancelled in the sheet: back to the form, no error', async () => {
    openAuthSession.mockResolvedValue({ type: 'cancel' })
    const { onSignedIn, user } = await typeHub('sso.example.com')
    await user.press(await screen.findByText('Sign in with Microsoft'))
    await waitFor(() => expect(openAuthSession).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeEnabled()
    )
    expect(screen.queryByText('Sign-in was cancelled.')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
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
      expect(
        await screen.findByText(cantReachHub('sso.example.com', 'unreachable'))
      ).toBeOnTheScreen()
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

describe('SignInScreen: the form', () => {
  it('says what a hub is, under the app name, with a real-world placeholder', async () => {
    await render(<SignInScreen title="Sign in to a hub" onSignedIn={jest.fn()} />)
    expect(screen.getByText('SlayZone')).toBeOnTheScreen()
    expect(
      screen.getByText(
        'A hub is the SlayZone server your desktop app or your team runs. Ask whoever set it up for its address.'
      )
    ).toBeOnTheScreen()
    expect(screen.getByPlaceholderText('hub.yourcompany.com')).toBeOnTheScreen()
    expect(screen.queryByPlaceholderText(/127\.0\.0\.1/)).toBeNull()
  })

  it('scrolls, so nothing is pushed out of reach by the keyboard or landscape', async () => {
    await render(<SignInScreen title="Sign in to a hub" onSignedIn={jest.fn()} />)
    const scroller = screen.getByTestId('sign-in-scroll')
    expect(scroller.props.keyboardShouldPersistTaps).toBe('handled')
  })

  it('Return moves from field to field, and Go on the password signs in', async () => {
    await render(<SignInScreen title="Sign in to a hub" onSignedIn={jest.fn()} />)
    const hub = screen.getByPlaceholderText('hub.yourcompany.com')
    const email = screen.getByPlaceholderText('you@example.com')
    const password = screen.getByTestId('sign-in-password')
    expect(hub.props.returnKeyType).toBe('next')
    expect(email.props.returnKeyType).toBe('next')
    expect(password.props.returnKeyType).toBe('go')
    expect(hub.props.autoCapitalize).toBe('none')
    expect(hub.props.autoCorrect).toBe(false)
    expect(hub.props.keyboardType).toBe('url')

    const user = userEvent.setup()
    await user.type(hub, 'pw.example.com')
    await user.type(email, 'me@example.com')
    await user.type(password, 'wrong', { submitEditing: true })
    await waitFor(() => expect(screen.getByRole('alert')).toBeOnTheScreen())
  })

  it('the Sign in button is a button; the fields are read-only while signing in', async () => {
    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const realFetch = global.fetch
    global.fetch = jest.fn(async (input: string) => {
      await pending
      return realFetch(input)
    }) as unknown as typeof fetch
    await render(<SignInScreen title="Sign in to a hub" onSignedIn={jest.fn()} />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('hub.yourcompany.com'), 'pw.example.com')
    await user.type(screen.getByPlaceholderText('you@example.com'), 'me@example.com')
    await user.type(screen.getByTestId('sign-in-password'), 'pw')
    await user.press(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByPlaceholderText('hub.yourcompany.com').props.editable).toBe(false)
    expect(screen.getByTestId('sign-in-password').props.editable).toBe(false)
    await act(async () => release())
  })

  it('the spinner shows only in the button of the way in flight', async () => {
    openAuthSession.mockImplementation(() => new Promise(() => undefined))
    const { user } = await typeHub('both.example.com')
    await user.press(await screen.findByText('Sign in with Microsoft'))
    await waitFor(() => expect(openAuthSession).toHaveBeenCalled())
    expect(screen.getByTestId('sign-in-microsoft-busy')).toBeOnTheScreen()
    expect(screen.queryByTestId('sign-in-password-busy')).toBeNull()
    expect(screen.getByText('Sign in')).toBeOnTheScreen()
  })

  it('tells VoiceOver what went wrong', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
    await render(<SignInScreen title="Sign in to a hub" onSignedIn={jest.fn()} />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('hub.yourcompany.com'), 'down.example.com')
    await user.type(screen.getByPlaceholderText('you@example.com'), 'me@example.com')
    await user.type(screen.getByTestId('sign-in-password'), 'pw')
    await user.press(screen.getByRole('button', { name: 'Sign in' }))
    const error = cantReachHub('down.example.com', 'unreachable')
    expect(await screen.findByRole('alert')).toHaveTextContent(error)
    expect(announce).toHaveBeenCalledWith(error)
    announce.mockRestore()
  })
})

describe('SignInScreen: a hub already signed in to', () => {
  it('says so: signing in again replaces that sign-in', async () => {
    await render(
      <SignInScreen
        title="Sign in to another hub"
        onSignedIn={jest.fn()}
        onCancel={jest.fn()}
        signedInAddresses={['pw.example.com']}
      />
    )
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('hub.yourcompany.com'), 'https://PW.example.com')
    expect(
      screen.getByText(
        "You're already signed in to pw.example.com. Signing in again replaces that sign-in."
      )
    ).toBeOnTheScreen()
  })
})
