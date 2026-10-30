/**
 * "Sign in with Microsoft": the hub's app sign-in (`@slayzone/hub-auth/client`,
 * `app-sign-in`) in iOS's auth session.
 *
 *   1. Ask the hub whether it offers it (`/health` → `appSignIn.microsoft`).
 *   2. A PKCE pair and a state (expo-crypto: Hermes has no `crypto.subtle`), and the hub's
 *      start URL, opened in ASWebAuthenticationSession (expo-web-browser). It shares
 *      Safari's cookies, so Microsoft may already know the person (iOS asks first:
 *      "SlayZone wants to use <hub> to sign in").
 *   3. The person signs in with Microsoft (the hub checks tenant, app role and MFA) and
 *      confirms on the hub's page; the session ends on `slayzone://auth/callback` with a
 *      single-use code for THIS state.
 *   4. The code and the verifier are traded for the hub's session token, kept in the
 *      keychain exactly like a password sign-in's (`hubSessions`).
 *
 * Everything that can stop it ends as one message for the sign-in screen.
 */
import {
  exchangeAppSignInCode,
  type HubTransport,
  type PkceCrypto,
  readAppSignInCallback,
  signInErrorMessage,
  startAppSignIn
} from '@slayzone/hub-auth/client'
import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'
import {
  hubEntryOf,
  type HubSession,
  type HubSessionStore,
  hubSessions,
  hubTransport,
  probeSignInOffer,
  type SignInResult
} from '../hub-session'

/**
 * How the auth session ended: `success` with the URL it was sent to, or why it closed
 * without one (`cancel`, `dismiss`, `locked`: another session is open).
 */
export interface AuthSessionResult {
  type: string
  url?: string
}

export interface MicrosoftSignInDeps {
  crypto: PkceCrypto
  /** Open `url` in the auth session; it completes when the browser reaches `redirectUri`. */
  openAuthSession: (url: string, redirectUri: string) => Promise<AuthSessionResult>
  transport: HubTransport
  sessions: Pick<HubSessionStore, 'save'>
}

/** Randomness and SHA-256 from expo-crypto. */
export const expoPkceCrypto: PkceCrypto = {
  getRandomValues: (bytes) => Crypto.getRandomValues(bytes),
  sha256: (data) => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data)
}

const appDeps: MicrosoftSignInDeps = {
  crypto: expoPkceCrypto,
  openAuthSession: async (url, redirectUri) => {
    const result = await WebBrowser.openAuthSessionAsync(url, redirectUri, {
      // Safari's cookies: Microsoft's single sign-on (the user's decision).
      preferEphemeralSession: false
    })
    return result.type === 'success' ? { type: 'success', url: result.url } : { type: result.type }
  },
  transport: hubTransport,
  sessions: hubSessions
}

const unreachable = (error: string): SignInResult => ({
  ok: false,
  error: `Could not reach the hub: ${error}`
})

/** Sign in to the hub at `address` (`host[:port]`) with Microsoft; keeps the session. */
export async function signInWithMicrosoft(
  address: string,
  deps: MicrosoftSignInDeps = appDeps
): Promise<SignInResult> {
  const probe = await probeSignInOffer(address, deps.transport)
  if (!probe.ok) {
    return probe.reason === 'address' ? { ok: false, error: probe.error } : unreachable(probe.error)
  }
  if (!probe.offer.microsoft)
    return { ok: false, error: 'This hub does not offer Microsoft sign-in' }

  const pending = await startAppSignIn(probe.baseUrl, deps.crypto)
  let ended: AuthSessionResult
  try {
    ended = await deps.openAuthSession(pending.url, pending.redirectUri)
  } catch (err) {
    return {
      ok: false,
      error: `Could not open the sign-in window: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (ended.type !== 'success' || ended.url === undefined) {
    return {
      ok: false,
      error:
        ended.type === 'locked'
          ? 'Another sign-in window is already open. Finish or close it first.'
          : 'Sign-in was cancelled.'
    }
  }
  const callback = readAppSignInCallback(ended.url, pending)
  if (!callback.ok) return { ok: false, error: callback.message }

  const exchanged = await exchangeAppSignInCode(deps.transport, probe.baseUrl, {
    code: callback.code,
    verifier: pending.verifier,
    redirectUri: pending.redirectUri
  })
  if (!exchanged.ok) {
    switch (exchanged.reason) {
      case 'unreachable':
      case 'timeout':
        return unreachable(exchanged.error)
      case 'expired':
        return { ok: false, error: 'The sign-in took too long to finish. Try again.' }
      default:
        return {
          ok: false,
          error:
            exchanged.code === 'ACCOUNT_DISABLED'
              ? signInErrorMessage('ACCOUNT_DISABLED')
              : 'The hub refused the sign-in. Try again.'
        }
    }
  }
  const session: HubSession = { entry: hubEntryOf(address.trim()), token: exchanged.token }
  await deps.sessions.save(session)
  return { ok: true, session }
}
