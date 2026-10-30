/**
 * App sign-in through Microsoft: how a NATIVE app (the iOS app) signs in to an Entra hub
 * — OAuth 2.0 for native apps (RFC 8252) with PKCE (RFC 7636, S256 only), the hub as the
 * authorization server, Entra behind it exactly as for the web shell. The client half is
 * `src/client/app-sign-in.ts`.
 *
 *   1. `GET /api/auth/app-sso?redirect_uri&code_challenge&code_challenge_method=S256&state`
 *      — the app opens this in its auth session (ASWebAuthenticationSession). Every
 *      parameter is checked strictly; the redirect must be one of {@link APP_REDIRECT_URIS}
 *      EXACTLY. Anything wrong is a 400 page and never a redirect — no open redirect.
 *      The flow (challenge, state, redirect, start time) goes into a signed, HttpOnly
 *      cookie on this browser ({@link APP_FLOW_COOKIE}), and the browser ALWAYS goes
 *      through Entra (sso-page.ts), back to `?return=1`.
 *   2. `GET ?return=1` — only in the browser that started (the flow cookie), only with an
 *      Entra-made better-auth session (T-09's checks: tenant, app role, `amr` ∋ `mfa`; not
 *      disabled) created AFTER the flow started, as the device page demands. Then the
 *      confirm page: which hub, which account, Continue / Cancel. A refusal goes back to
 *      the app as `error=<code>` with the app's state; it never loops into Entra.
 *   3. `POST /api/auth/app-sso/confirm` — the page's cookie-authenticated form, so a
 *      trusted `Origin` is required (CSRF). Continue: a single-use code (256 bits, valid
 *      {@link APP_CODE_TTL_MS}) bound to the account, the challenge and the redirect;
 *      the browser's better-auth session is ended (it only proved who the person is — a
 *      browser keeps no hub credential); 302 `<redirect>?code&state`. Cancel:
 *      `error=access_denied`.
 *   4. `POST /api/auth/app-sso/token` `{code, code_verifier, redirect_uri}` (JSON) — the
 *      app's exchange: the same better-auth session token `sign-in/email` hands out (the
 *      hub's 7-day sliding lifetime), marked `signInMethod: 'app'`.
 *
 * WHY THE CONFIRM PAGE. A custom scheme (`slayzone://`) can be claimed by any app on the
 * device. Without a person's confirmation, a link to step 1 with an attacker's challenge,
 * opened where Microsoft signs in silently, would hand the code to whichever app owns the
 * scheme (RFC 8252 §8.6: no automatic authorization for a client whose identity cannot
 * be assured). The device page asks for the same reason.
 *
 * THE CODE. Single use: burned at its FIRST presentation, whatever the outcome — a wrong
 * verifier included. Presented again, the session it minted is revoked (RFC 6749 §4.1.2).
 * The verifier must hash (S256, timing-safe) to the challenge, the redirect must match.
 * Held in MEMORY, hashed: a hub is one node and a code lives a minute, so a restart costs
 * at most an in-flight sign-in (the app says "try again"); at most
 * {@link MAX_PENDING_APP_CODES} live codes at once.
 *
 * EVERY EXISTING CHECK APPLIES: Entra's are better-auth's callback (unchanged); the
 * session is created through `internalAdapter.createSession`, so the disabled-account
 * guard runs at the exchange too (account.ts); the token is an ordinary session of an
 * Entra user, so the hourly re-check and disabling the account end it. It is never
 * `signInMethod: 'sso'`, so it can neither approve a device code nor mint a web session.
 *
 * AUDIT. `auth.app_sso.code` (issued, cancelled, capped), `auth.signin` with `method:
 * 'app'` for the exchange (and why one failed), `auth.app_sso.replay`. `requestRef` (a
 * keyed hash of the code) correlates them; no code, verifier or token is ever written.
 *
 * Rate limits and the bearer gate's openings are the hub's (flood-limits.ts, rest-auth.ts).
 * Installed on Entra hubs only (server.ts), like the web sign-in.
 *
 * @module hub-auth/app-sign-in
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLIENT_ADDRESS_HEADER } from '@slayzone/platform/client-address'
import { runAsSecurityActor, securityEvent } from '@slayzone/platform/security-log'
import { isAPIError } from 'better-auth/api'
import { ACCOUNT_DISABLED_CODE } from './account'
import type { HubAuth } from './auth'
import { SIGN_IN_METHOD } from './device'
import {
  cookieOnlyHeaders,
  escapeHtml as esc,
  formOriginRefusal,
  readUrlEncodedForm,
  redirectToEntraSignIn,
  sendHubPage,
  type SsoBrowserSession,
  ssoSessionFromCookie
} from './sso-page'

/** The start and return legs. Under `/api/auth/` but the hub's, not better-auth's. */
export const APP_SIGN_IN_PATH = '/api/auth/app-sso'
/** The confirm page's form. */
export const APP_SIGN_IN_CONFIRM_PATH = `${APP_SIGN_IN_PATH}/confirm`
/** The app's code exchange. */
export const APP_SIGN_IN_TOKEN_PATH = `${APP_SIGN_IN_PATH}/token`

/**
 * Where the hub may send an app back — compared EXACTLY. The app registers the scheme.
 * The client's `APP_SIGN_IN_REDIRECT_URI` must be one of these (a test pins it).
 */
export const APP_REDIRECT_URIS: readonly string[] = ['slayzone://auth/callback']

/** How long a code may wait for its exchange. */
export const APP_CODE_TTL_MS = 60_000
/** How long a sign-in may take from the app's start to the confirm (Entra + MFA). */
export const APP_FLOW_TTL_MS = 10 * 60_000
/** Live (unused, unexpired) codes allowed at once on one hub. */
export const MAX_PENDING_APP_CODES = 100
/** The flow cookie (signed; challenge, state, redirect, start time — nothing secret). */
export const APP_FLOW_COOKIE = 'slayzone_app_sso'

const MAX_FORM_BYTES = 2048
const MAX_TOKEN_BODY_BYTES = 4096

/** RFC 7636: S256 of a 43–128 character verifier is 32 bytes → 43 base64url characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const STATE = /^[A-Za-z0-9._~-]{16,256}$/
/** A code this hub issued: 32 random bytes, base64url. */
const CODE = /^[A-Za-z0-9_-]{43}$/
/** What a refusal's `error` may carry back to the app (better-auth's codes). */
const REASON = /^[A-Za-z0-9_]{1,64}$/

/** `form-action` of the confirm page: itself, and the app schemes its answer redirects to. */
const FORM_ACTION = [
  "'self'",
  ...new Set(APP_REDIRECT_URIS.map((u) => `${u.slice(0, u.indexOf(':'))}:`))
].join(' ')

export interface AppSignInOptions {
  /** The flow cookie's `Secure` flag: exactly when the hub's public address is https. */
  secureCookie: boolean
  /** Test seam: the cap on live codes ({@link MAX_PENDING_APP_CODES}). */
  maxPendingCodes?: number
  /** Test seam: the clock. */
  now?: () => number
}

interface Flow {
  challenge: string
  state: string
  redirectUri: string
  startedAt: number
}

interface IssuedCode {
  userId: string
  challenge: string
  redirectUri: string
  expiresAt: number
  requestRef: string
  /** Presented once already: any further presentation is a replay. */
  used: boolean
  /** A replay arrived while the first exchange was still minting. */
  replayed: boolean
  /** The session the exchange minted, revoked on a replay. */
  sessionToken: string | null
}

interface SignOutApi {
  signOut(input: { headers: Headers; returnHeaders: true }): Promise<{ headers: Headers }>
}

const sha256Url = (s: string): string => createHash('sha256').update(s).digest('base64url')

/** The challenge was `BASE64URL(SHA256(verifier))`. Timing-safe. */
function verifierMatches(verifier: string, challenge: string): boolean {
  const expected = createHash('sha256').update(verifier, 'ascii').digest()
  const given = Buffer.from(challenge, 'base64url')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const macOf = (secret: string, payload: string): Buffer =>
  createHmac('sha256', secret).update(`app-sso-flow:${payload}`).digest()

function sealFlow(secret: string, flow: Flow): string {
  const payload = Buffer.from(
    JSON.stringify({ c: flow.challenge, s: flow.state, r: flow.redirectUri, t: flow.startedAt })
  ).toString('base64url')
  return `${payload}.${macOf(secret, payload).toString('base64url')}`
}

/** The flow a cookie value carries, when its signature holds and it is young enough. */
function openFlow(secret: string, value: string | undefined, now: number): Flow | null {
  if (!value) return null
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = value.slice(0, dot)
  const mac = Buffer.from(value.slice(dot + 1), 'base64url')
  const expected = macOf(secret, payload)
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  const flow = { challenge: raw.c, state: raw.s, redirectUri: raw.r, startedAt: raw.t }
  if (
    typeof flow.challenge !== 'string' ||
    !CHALLENGE.test(flow.challenge) ||
    typeof flow.state !== 'string' ||
    !STATE.test(flow.state) ||
    typeof flow.redirectUri !== 'string' ||
    !APP_REDIRECT_URIS.includes(flow.redirectUri) ||
    typeof flow.startedAt !== 'number' ||
    now - flow.startedAt > APP_FLOW_TTL_MS ||
    flow.startedAt > now
  ) {
    return null
  }
  return flow as Flow
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** `<redirect>?<params>`, every value encoded. */
const appUrl = (redirectUri: string, params: Array<[string, string]>): string =>
  `${redirectUri}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`

/**
 * The route handler. Returns true when it took the request (the three paths above), so
 * the hub's dispatcher stops there.
 */
export function createAppSignIn(
  auth: HubAuth,
  opts: AppSignInOptions
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const now = opts.now ?? Date.now
  const maxPending = opts.maxPendingCodes ?? MAX_PENDING_APP_CODES
  const api = auth.api as unknown as SignOutApi
  const codes = new Map<string, IssuedCode>()
  const secure = opts.secureCookie ? '; Secure' : ''
  const flowCookie = (value: string): string =>
    `${APP_FLOW_COOKIE}=${value}; Path=${APP_SIGN_IN_PATH}; HttpOnly; SameSite=Lax; Max-Age=${APP_FLOW_TTL_MS / 1000}${secure}`
  const clearFlow = `${APP_FLOW_COOKIE}=; Path=${APP_SIGN_IN_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`

  const secret = async (): Promise<string> => (await auth.$context).secret
  const requestRefOf = (key: string, code: string): string =>
    createHmac('sha256', key).update(`app-sso:${code}`).digest('hex').slice(0, 16)

  const redirect = (res: ServerResponse, location: string, cookies: string[] = []): void => {
    if (res.headersSent) return
    res.writeHead(302, {
      location,
      ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    })
    res.end()
  }

  /** Back to the app with a refusal: its state when the flow is known. */
  const refuse = (res: ServerResponse, flow: Flow | null, error: string, cookies: string[] = []) =>
    redirect(
      res,
      appUrl(flow?.redirectUri ?? APP_REDIRECT_URIS[0]!, [
        ['error', error],
        ...(flow ? ([['state', flow.state]] as Array<[string, string]>) : [])
      ]),
      [clearFlow, ...cookies]
    )

  const page = (res: ServerResponse, status: number, title: string, body: string): void =>
    sendHubPage(res, { status, title, body, formAction: FORM_ACTION })

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    if (res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /** This browser's Entra session, when made after the flow started. */
  const freshSession = async (headers: Headers, flow: Flow): Promise<SsoBrowserSession | null> => {
    const sso = await ssoSessionFromCookie(auth, headers)
    return sso && sso.createdAt >= flow.startedAt ? sso : null
  }

  /** End the browser's better-auth session: its clearing cookies. */
  const endBrowserSession = async (headers: Headers): Promise<string[]> => {
    try {
      return (await api.signOut({ headers, returnHeaders: true })).headers.getSetCookie()
    } catch {
      // It then ends at its own expiry; the app's code does not depend on it.
      return []
    }
  }

  const start = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const q = url.searchParams
    const redirectUri = q.get('redirect_uri') ?? ''
    const challenge = q.get('code_challenge') ?? ''
    const state = q.get('state') ?? ''
    if (
      !APP_REDIRECT_URIS.includes(redirectUri) ||
      q.get('code_challenge_method') !== 'S256' ||
      !CHALLENGE.test(challenge) ||
      !STATE.test(state)
    ) {
      page(
        res,
        400,
        'Not a valid sign-in',
        '<p>This sign-in link is not valid. Start the sign-in again in the SlayZone app.</p>'
      )
      return
    }
    const flow: Flow = { challenge, state, redirectUri, startedAt: now() }
    await redirectToEntraSignIn(
      auth,
      res,
      cookieOnlyHeaders(req),
      {
        callbackURL: `${APP_SIGN_IN_PATH}?return=1`,
        errorCallbackURL: `${APP_SIGN_IN_PATH}?return=1&signin=failed`
      },
      [flowCookie(sealFlow(await secret(), flow))]
    )
  }

  const back = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const flow = openFlow(await secret(), cookieValue(req, APP_FLOW_COOKIE), now())
    if (!flow) return refuse(res, null, 'flow_expired')
    if (url.searchParams.has('signin') || url.searchParams.has('error')) {
      const reason = url.searchParams.get('error')
      return refuse(res, flow, reason && REASON.test(reason) ? reason : 'signin_failed')
    }
    const sso = await freshSession(cookieOnlyHeaders(req), flow)
    if (!sso) return refuse(res, flow, 'no_session')
    const hubHost = new URL((await auth.$context).baseURL).host
    const form = (decision: string, label: string): string =>
      `<form method="post" action="${APP_SIGN_IN_CONFIRM_PATH}">` +
      `<input type="hidden" name="decision" value="${decision}">` +
      `<button type="submit">${label}</button></form>`
    page(
      res,
      200,
      'Sign in to the SlayZone app?',
      `<p>The <b>SlayZone app</b> is asking to sign in to <b>${esc(hubHost)}</b> as ` +
        `<b>${esc(sso.email)}</b>.</p>` +
        '<p class="warn">Continue only if you started this sign-in in the SlayZone app on ' +
        'this device, just now. The app gets full access to your account on this hub ' +
        'until it signs out.</p>' +
        form('continue', 'Continue') +
        form('cancel', 'Cancel')
    )
  }

  const confirm = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const refused = await formOriginRefusal(auth, req)
    if (refused) {
      securityEvent({
        event: 'authz.denied',
        outcome: 'denied',
        actor: null,
        detail: { reason: refused, status: 403 }
      })
      page(res, 403, 'Refused', '<p>This form must be sent from the hub’s own page.</p>')
      return
    }
    const key = await secret()
    const flow = openFlow(key, cookieValue(req, APP_FLOW_COOKIE), now())
    if (!flow) return refuse(res, null, 'flow_expired')
    const decision = (await readUrlEncodedForm(req, MAX_FORM_BYTES))?.get('decision')
    if (decision !== 'continue' && decision !== 'cancel') {
      page(res, 400, 'Not a valid answer', '<p>Start the sign-in again in the SlayZone app.</p>')
      return
    }
    const headers = cookieOnlyHeaders(req)
    const sso = await freshSession(headers, flow)
    if (!sso) return refuse(res, flow, 'no_session')
    const signedOut = await endBrowserSession(headers)
    if (decision === 'cancel') {
      securityEvent({
        event: 'auth.app_sso.code',
        outcome: 'denied',
        actor: sso.userId,
        detail: { reason: 'cancelled' }
      })
      return refuse(res, flow, 'access_denied', signedOut)
    }
    // Forget codes a minute past their expiry (kept that long to recognise a replay).
    for (const [k, c] of codes) if (c.expiresAt + APP_CODE_TTL_MS <= now()) codes.delete(k)
    let live = 0
    for (const c of codes.values()) if (!c.used && c.expiresAt > now()) live++
    if (live >= maxPending) {
      securityEvent({
        event: 'auth.app_sso.code',
        outcome: 'denied',
        actor: sso.userId,
        detail: { reason: 'too_many_pending' }
      })
      return refuse(res, flow, 'temporarily_unavailable', signedOut)
    }
    const code = randomBytes(32).toString('base64url')
    const requestRef = requestRefOf(key, code)
    codes.set(sha256Url(code), {
      userId: sso.userId,
      challenge: flow.challenge,
      redirectUri: flow.redirectUri,
      expiresAt: now() + APP_CODE_TTL_MS,
      requestRef,
      used: false,
      replayed: false,
      sessionToken: null
    })
    securityEvent({
      event: 'auth.app_sso.code',
      outcome: 'success',
      actor: sso.userId,
      targetKind: 'user',
      targetId: sso.userId,
      detail: { requestRef }
    })
    redirect(
      res,
      appUrl(flow.redirectUri, [
        ['code', code],
        ['state', flow.state]
      ]),
      [clearFlow, ...signedOut]
    )
  }

  /** The JSON body of an exchange: its fields, or why not. */
  const readExchange = async (
    req: IncomingMessage
  ): Promise<{ code: string; verifier: string; redirectUri: string } | 'too_large' | 'invalid'> => {
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
    if (type !== 'application/json') return 'invalid'
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_TOKEN_BODY_BYTES) return 'too_large'
      chunks.push(chunk as Buffer)
    }
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return 'invalid'
    }
    const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as {
      code?: unknown
      code_verifier?: unknown
      redirect_uri?: unknown
    }
    if (
      typeof b.code !== 'string' ||
      !CODE.test(b.code) ||
      typeof b.code_verifier !== 'string' ||
      !VERIFIER.test(b.code_verifier) ||
      typeof b.redirect_uri !== 'string'
    ) {
      return 'invalid'
    }
    return { code: b.code, verifier: b.code_verifier, redirectUri: b.redirect_uri }
  }

  const token = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const input = await readExchange(req)
    if (input === 'too_large') {
      json(res, 413, { error: 'invalid_request', error_description: 'Request body too large' })
      return
    }
    if (input === 'invalid') {
      json(res, 400, { error: 'invalid_request' })
      return
    }
    const ctx = await auth.$context
    const requestRef = requestRefOf(ctx.secret, input.code)
    const invalid = (reason: string, actor: string | null = null): void => {
      securityEvent({
        event: 'auth.signin',
        outcome: 'failure',
        actor,
        detail: { method: 'app', reason, requestRef }
      })
      json(res, 400, { error: 'invalid_grant', code: 'CODE_INVALID' })
    }
    const issued = codes.get(sha256Url(input.code))
    if (!issued) return invalid('unknown_code')
    if (issued.used) {
      // Every check below already ran once for this code: a second presentation is a
      // replay, and whatever the first one got must not stand.
      issued.replayed = true
      const minted = issued.sessionToken
      issued.sessionToken = null
      if (minted) await ctx.internalAdapter.deleteSession(minted)
      securityEvent({
        event: 'auth.app_sso.replay',
        outcome: 'denied',
        actor: null,
        targetKind: 'user',
        targetId: issued.userId,
        detail: { requestRef, revoked: minted !== null }
      })
      json(res, 400, { error: 'invalid_grant', code: 'CODE_INVALID' })
      return
    }
    // Burned here, before any await: two exchanges racing cannot both pass.
    issued.used = true
    if (issued.expiresAt <= now()) {
      securityEvent({
        event: 'auth.signin',
        outcome: 'failure',
        actor: null,
        detail: { method: 'app', reason: 'expired_code', requestRef }
      })
      json(res, 400, { error: 'invalid_grant', code: 'CODE_EXPIRED' })
      return
    }
    if (input.redirectUri !== issued.redirectUri) return invalid('redirect_mismatch')
    if (!verifierMatches(input.verifier, issued.challenge)) return invalid('verifier_mismatch')

    const address = req.headers[CLIENT_ADDRESS_HEADER]
    let session: { token: string }
    try {
      session = await runAsSecurityActor(issued.userId, () =>
        ctx.internalAdapter.createSession(
          issued.userId,
          false,
          {
            signInMethod: SIGN_IN_METHOD.app,
            ipAddress: typeof address === 'string' ? address : '',
            userAgent:
              typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : ''
          },
          true
        )
      )
    } catch (err) {
      // The disabled-account guard (account.ts) wrote its own `auth.signin` denied line.
      if (
        isAPIError(err) &&
        (err.body as { code?: unknown } | undefined)?.code === ACCOUNT_DISABLED_CODE
      ) {
        json(res, 403, { error: 'access_denied', code: ACCOUNT_DISABLED_CODE })
        return
      }
      throw err
    }
    if (issued.replayed) {
      // A replay arrived while this one was minting: the session must not stand.
      await ctx.internalAdapter.deleteSession(session.token)
      json(res, 400, { error: 'invalid_grant', code: 'CODE_INVALID' })
      return
    }
    issued.sessionToken = session.token
    securityEvent({
      event: 'auth.signin',
      outcome: 'success',
      actor: issued.userId,
      detail: { method: 'app', requestRef }
    })
    json(res, 200, { token: session.token })
  }

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub.invalid')
    const path = url.pathname
    const route =
      path === APP_SIGN_IN_PATH
        ? {
            method: 'GET',
            run: () => (url.searchParams.get('return') === '1' ? back : start)(req, res, url)
          }
        : path === APP_SIGN_IN_CONFIRM_PATH
          ? { method: 'POST', run: () => confirm(req, res) }
          : path === APP_SIGN_IN_TOKEN_PATH
            ? { method: 'POST', run: () => token(req, res) }
            : null
    if (!route) return false
    if (req.method !== route.method) {
      res.writeHead(405, { allow: route.method, 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return true
    }
    route.run().catch(() => {
      if (path === APP_SIGN_IN_TOKEN_PATH) json(res, 500, { error: 'server_error' })
      else refuse(res, null, 'server_error')
    })
    return true
  }
}
