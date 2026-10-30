/**
 * App sign-in through Microsoft — how a NATIVE app (the iOS app) signs in to a hub with
 * Entra sign-in, without a password and without a second device. OAuth 2.0 for native
 * apps (RFC 8252) with PKCE (RFC 7636, S256 only), the hub as the authorization server:
 *
 *   1. app   {@link startAppSignIn}: a PKCE pair and a state, and the hub's start URL
 *            (`GET /api/auth/app-sso?redirect_uri&code_challenge&code_challenge_method&state`),
 *            opened in the platform's auth session (ASWebAuthenticationSession).
 *   2. hub   sends the browser through Entra (tenant, app role, MFA — the hub's existing
 *            checks), asks the person to confirm, then redirects to the app's fixed
 *            redirect URI with a single-use code (≤ 60 s) bound to the challenge, or an
 *            `error` code. The state comes back unchanged.
 *   3. app   {@link readAppSignInCallback}: the code, only for our state and redirect.
 *   4. app   {@link exchangeAppSignInCode}: code + verifier → the same better-auth session
 *            token `sign-in/email` gives.
 *
 * Hub side: `src/server/app-sign-in.ts`.
 *
 * PLATFORM-NEUTRAL like the rest of this entry: randomness and SHA-256 are INJECTED
 * ({@link PkceCrypto}: WebCrypto in Node or a browser, expo-crypto in React Native, where
 * Hermes has no `crypto.subtle`), and URLs are built and read as strings — React Native's
 * `URL` is partial.
 */
import { AUTH_TIMEOUT_MS, jsonObject, postJson, stringOf } from './protocol'
import { signInErrorMessage } from './sign-in-error'
import {
  type HubHttpResponse,
  type HubTransport,
  isHubTransportTimeout,
  transportErrorText
} from './transport'

/** The hub's app sign-in routes. Must match the hub's (`src/server/app-sign-in.ts`; a test pins it). */
export const APP_SIGN_IN_PATHS = {
  start: '/api/auth/app-sso',
  token: '/api/auth/app-sso/token'
} as const

/**
 * Where the hub sends the app back. One of the hub's allow-listed redirect URIs
 * (`APP_REDIRECT_URIS`, a test pins it); the app registers the `slayzone` scheme.
 */
export const APP_SIGN_IN_REDIRECT_URI = 'slayzone://auth/callback'

/** Randomness and SHA-256 from the platform. */
export interface PkceCrypto {
  /** Fills `bytes` with cryptographically strong random values and returns it. */
  getRandomValues(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>
  sha256(data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer | Uint8Array>
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url without padding (RFC 4648 §5). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64URL[n >> 18]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += B64URL[n >> 18]! + B64URL[(n >> 12) & 63]!
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64URL[n >> 18]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!
  }
  return out
}

/** `byteLength` random bytes as base64url: 32 bytes → 43 characters (256 bits). */
export function randomUrlToken(crypto: PkceCrypto, byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)))
}

/** `BASE64URL(SHA256(ASCII(verifier)))` (RFC 7636 §4.2). The verifier is ASCII by definition. */
export async function pkceS256Challenge(verifier: string, crypto: PkceCrypto): Promise<string> {
  const ascii = new Uint8Array(verifier.length)
  for (let i = 0; i < verifier.length; i++) ascii[i] = verifier.charCodeAt(i) & 0x7f
  return base64UrlEncode(new Uint8Array(await crypto.sha256(ascii)))
}

/** A fresh PKCE pair: a 43-character verifier (32 random bytes) and its S256 challenge. */
export async function createPkcePair(
  crypto: PkceCrypto
): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomUrlToken(crypto)
  return { verifier, challenge: await pkceS256Challenge(verifier, crypto) }
}

/** One app sign-in in flight. The verifier never leaves the app until the exchange. */
export interface PendingAppSignIn {
  /** The hub's start URL, to open in the platform's auth session. */
  url: string
  state: string
  verifier: string
  redirectUri: string
}

/** Begin an app sign-in at the hub `baseUrl` (http(s) origin, optional path prefix). */
export async function startAppSignIn(
  baseUrl: string,
  crypto: PkceCrypto,
  redirectUri: string = APP_SIGN_IN_REDIRECT_URI
): Promise<PendingAppSignIn> {
  const { verifier, challenge } = await createPkcePair(crypto)
  const state = randomUrlToken(crypto)
  const query = [
    ['redirect_uri', redirectUri],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['state', state]
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join('&')
  return { url: `${baseUrl}${APP_SIGN_IN_PATHS.start}?${query}`, state, verifier, redirectUri }
}

export type AppSignInCallback =
  | { ok: true; code: string }
  | {
      ok: false
      /**
       * `refused`: the hub (or Microsoft through it) said why — `code` picks a fixed
       * message. `mismatch`: not an answer to THIS sign-in (another state, another
       * redirect, neither code nor error) — nothing in it is used.
       */
      reason: 'refused' | 'mismatch'
      code?: string
      /** What to show. */
      message: string
    }

/** better-auth's own charset for an error code (as `sign-in-error.ts`). */
const ERROR_CODE = /^[A-Za-z0-9_'-]{1,64}$/

const MISMATCH = 'The sign-in answer did not match this sign-in. Try again.'

/** The query of `url` as a map (first value wins); `#…` dropped. */
function queryOf(url: string): Map<string, string> {
  const params = new Map<string, string>()
  const q = url.indexOf('?')
  if (q === -1) return params
  const hash = url.indexOf('#', q)
  for (const pair of url.slice(q + 1, hash === -1 ? undefined : hash).split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const decode = (s: string): string | null => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '))
      } catch {
        return null
      }
    }
    const key = decode(eq === -1 ? pair : pair.slice(0, eq))
    const value = decode(eq === -1 ? '' : pair.slice(eq + 1))
    if (key !== null && value !== null && !params.has(key)) params.set(key, value)
  }
  return params
}

/**
 * Read the URL the auth session ended on. The code only for our redirect URI AND our
 * state. An error is shown when its state is ours or absent (the hub lost the flow and
 * cannot know it) — an error carries no credential; `error_description` is never shown.
 */
export function readAppSignInCallback(
  callbackUrl: string,
  pending: Pick<PendingAppSignIn, 'state' | 'redirectUri'>
): AppSignInCallback {
  const rest = callbackUrl.startsWith(pending.redirectUri)
    ? callbackUrl.slice(pending.redirectUri.length)
    : null
  if (rest === null || (rest !== '' && rest[0] !== '?' && rest[0] !== '#')) {
    return { ok: false, reason: 'mismatch', message: MISMATCH }
  }
  const params = queryOf(callbackUrl)
  const state = params.get('state')
  const error = params.get('error')
  if (error !== undefined && (state === undefined || state === pending.state)) {
    const code = ERROR_CODE.test(error) ? error : 'unknown'
    return { ok: false, reason: 'refused', code, message: signInErrorMessage(code) }
  }
  const code = params.get('code')
  if (state !== pending.state || error !== undefined || !code) {
    return { ok: false, reason: 'mismatch', message: MISMATCH }
  }
  return { ok: true, code }
}

export type AppSignInTokenResult =
  | { ok: true; token: string }
  | {
      ok: false
      /**
       * `unreachable` / `timeout`: no answer. `expired`: the code outlived its 60 s.
       * `refused`: any other HTTP ≥ 400 (used, wrong verifier, disabled account, …).
       * `no-token`: accepted but no token.
       */
      reason: 'unreachable' | 'timeout' | 'expired' | 'refused' | 'no-token'
      status?: number
      /** The body's `code` (`CODE_EXPIRED`, `CODE_INVALID`, `ACCOUNT_DISABLED`, …). */
      code?: string
      /** What to show. */
      error: string
    }

/** Trade the callback's code and this sign-in's verifier for a session token. */
export async function exchangeAppSignInCode(
  transport: HubTransport,
  baseUrl: string,
  input: { code: string; verifier: string; redirectUri: string },
  timeoutMs = AUTH_TIMEOUT_MS
): Promise<AppSignInTokenResult> {
  let res: HubHttpResponse
  try {
    res = await postJson(
      transport,
      `${baseUrl}${APP_SIGN_IN_PATHS.token}`,
      { code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri },
      timeoutMs
    )
  } catch (err) {
    return isHubTransportTimeout(err)
      ? { ok: false, reason: 'timeout', error: `Sign-in timed out after ${timeoutMs}ms` }
      : { ok: false, reason: 'unreachable', error: transportErrorText(err) }
  }
  const body = jsonObject(res.text)
  if (res.status >= 400) {
    const code = stringOf(body.code)
    return {
      ok: false,
      reason: code === 'CODE_EXPIRED' ? 'expired' : 'refused',
      status: res.status,
      code,
      error: `Sign-in failed (HTTP ${res.status})`
    }
  }
  const token = stringOf(body.token)
  if (token) return { ok: true, token }
  return { ok: false, reason: 'no-token', status: res.status, error: 'Hub returned no token' }
}

/** What a hub offers a native app, from its `/health`. */
export interface HubAppSignIn {
  /** "Sign in with Microsoft" (this flow) is served. */
  microsoft: boolean
}

/**
 * The `/health` reading: only an explicit `appSignIn.microsoft: true` counts. A hub
 * whose SSO switches are on but which predates the app routes says nothing, so the app
 * never offers a button that would fail. Pure.
 */
export function appSignInOf(health: unknown): HubAppSignIn {
  const app = (health as { appSignIn?: { microsoft?: unknown } } | null | undefined)?.appSignIn
  return { microsoft: app?.microsoft === true }
}
