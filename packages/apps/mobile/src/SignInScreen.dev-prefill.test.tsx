/**
 * The dev bundle's prefilled sign-in (`EXPO_PUBLIC_SPIKE_*`): it signs in by itself
 * once per app launch — never again after a sign-out, or signing out could not be done.
 */
import { render } from '@testing-library/react-native'

const mockSignIn = jest.fn(async () => ({ ok: false as const, error: 'stand-in' }))
jest.mock('./hub-session', () => ({
  ...jest.requireActual('./hub-session'),
  signIn: mockSignIn,
  probeSignInOffer: async () => ({ ok: false, reason: 'hub', error: 'stand-in' })
}))

process.env.EXPO_PUBLIC_SPIKE_HUB = 'home.example'
process.env.EXPO_PUBLIC_SPIKE_EMAIL = 'me@example.com'
process.env.EXPO_PUBLIC_SPIKE_PASSWORD = 'secret'
const { SignInScreen } = require('./SignInScreen') as typeof import('./SignInScreen')

it('signs in by itself on the first sign-in screen only, not after a sign-out', async () => {
  const first = await render(
    <SignInScreen title="Sign in" onSignedIn={() => undefined} devAutoSubmit />
  )
  expect(mockSignIn).toHaveBeenCalledTimes(1)
  expect(mockSignIn).toHaveBeenCalledWith('home.example', 'me@example.com', 'secret')
  await first.unmount()

  // Signed out: the sign-in screen again, in the same launch.
  await render(<SignInScreen title="Sign in" onSignedIn={() => undefined} devAutoSubmit />)
  expect(mockSignIn).toHaveBeenCalledTimes(1)
})
