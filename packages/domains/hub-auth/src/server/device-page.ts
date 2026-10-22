/**
 * The approval page of device sign-in (T-14, ./device.ts): where the person behind a
 * CLI, desktop app or Cloud Device approves its sign-in. Served by the hub at
 * `GET /device`, `POST /device/approve`, `POST /device/deny` — on an Entra hub only.
 *
 * WHO MAY APPROVE. The browser's better-auth session, from its COOKIE (never a bearer),
 * made by an Entra sign-in that passed T-09's checks (tenant, app role, `amr` ∋ `mfa`)
 * AFTER the device code was issued. Anything else — no session, a password
 * (break-glass) session, a device token's session, an Entra session from before the
 * code — is sent through Entra again first. So every device sign-in is one Entra
 * sign-in with MFA, and nothing short of one can produce a token.
 *
 * FLOW. `GET /device?user_code=…`: no fresh Entra session → 302 to Entra (better-auth's
 * `sign-in/social`, back to this page); then the code is looked up, claimed for this
 * account (the plugin binds it to the first account that opens it) and the page names
 * the client, the code and the hub, with Approve / Deny forms. Those POST back here,
 * which repeats every check, then approves or denies through the plugin.
 *
 * CSRF. The forms are cookie-authenticated POSTs, so each must carry an `Origin` the
 * hub trusts (its public address, `SLAYZONE_HUB_ALLOWED_WEB_ORIGINS`); a missing or
 * `null` Origin is refused, exactly as better-auth refuses one on its own cookie routes.
 *
 * WRONG CODES. A code is only ever looked up for a signed-in Entra account, so guessing
 * costs an Entra sign-in with MFA. On top, {@link WRONG_CODE_LIMIT} codes that match
 * nothing within {@link WRONG_CODE_WINDOW_MS} lock that account out of the page until
 * the window ends (in memory: a restart clears it; T-26 owns general rate limits).
 *
 * The page runs no script and loads nothing (`script-src` is never needed); its one
 * `<style>` passes the web shell's `style-src 'unsafe-inline'`.
 *
 * @module hub-auth/device-page
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { securityEvent } from '@slayzone/platform/security-log'
import { isAPIError } from 'better-auth/api'
import { isDisabled } from './account'
import type { HubAuth } from './auth'
import {
  DEVICE_CLIENTS,
  DEVICE_CODE_TTL_MS,
  DEVICE_PAGE_PATH,
  deviceRequestRef,
  SIGN_IN_METHOD
} from './device'
import { ENTRA_PROVIDER_ID } from './entra'

/** Codes matching nothing, per account, before the page locks that account out. */
export const WRONG_CODE_LIMIT = 5

/** The window {@link WRONG_CODE_LIMIT} counts in, and how long a lockout lasts. */
export const WRONG_CODE_WINDOW_MS = 15 * 60_000

/** better-auth's user-code alphabet (no 0/O, 1/I), 8 characters. */
const USER_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/

const MAX_FORM_BYTES = 2048

interface DeviceCodeRow {
  id: string
  deviceCode: string
  userCode: string
  userId?: string | null
  expiresAt: Date | string
  status: string
  clientId?: string | null
}

/** The plugin endpoints and the one core endpoint the page calls (in process). */
interface PageApi {
  signInSocial(input: {
    body: Record<string, unknown>
    headers: Headers
    returnHeaders: true
  }): Promise<{ headers: Headers; response: { url?: string } }>
  deviceVerify(input: { query: { user_code: string }; headers: Headers }): Promise<unknown>
  deviceApprove(input: { body: { userCode: string }; headers: Headers }): Promise<unknown>
  deviceDeny(input: { body: { userCode: string }; headers: Headers }): Promise<unknown>
}

export interface DevicePageOptions {
  /** Entra's login origin, for the page's `form-action` (a re-sign-in redirects there). */
  signInOrigin: string
  /** Test seam: the clock. */
  now?: () => number
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  )

/** What a person types or pastes (`abcd-efgh`, `ABCD EFGH`) → the stored form. */
export function normalizeUserCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : ''
}

const displayCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`

const toMs = (v: unknown): number =>
  v instanceof Date ? v.getTime() : new Date(String(v ?? '')).getTime()

/** Only the cookie: the page never accepts a bearer as the approving session. */
function cookieHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  if (typeof req.headers.cookie === 'string') headers.set('cookie', req.headers.cookie)
  return headers
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
  if (type !== 'application/x-www-form-urlencoded') return null
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_FORM_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/**
 * The page handler. Returns true when it took the request (`/device` and below), so
 * the hub's dispatcher stops there.
 */
export function createDevicePage(
  auth: HubAuth,
  opts: DevicePageOptions
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const api = auth.api as unknown as PageApi
  const now = opts.now ?? Date.now
  const misses = new Map<string, { count: number; since: number }>()

  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action 'self' ${opts.signInOrigin}`,
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ')

  const send = (res: ServerResponse, status: number, title: string, body: string): void => {
    if (res.headersSent) return
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': csp,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin'
    })
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${esc(title)}</title><style>` +
        'body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}' +
        'code{font-size:1.4em;letter-spacing:.1em}form{display:inline-block;margin:0 .5rem 0 0}' +
        'button{font:inherit;padding:.4rem 1.2rem}.warn{border-left:3px solid;padding-left:.8rem}' +
        `</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`
    )
  }

  const codeForm = (value = ''): string =>
    `<form method="get" action="${DEVICE_PAGE_PATH}"><p><label>Code ` +
    `<input name="user_code" value="${esc(value)}" maxlength="16" autocomplete="off" ` +
    `autocapitalize="characters" spellcheck="false" required></label> ` +
    `<button type="submit">Continue</button></p></form>`

  const restartLink = (code: string): string =>
    `<p><a href="${DEVICE_PAGE_PATH}?user_code=${encodeURIComponent(code)}">Try again</a></p>`

  /** Remaining lockout for an account, 0 when not locked. */
  const lockedFor = (userId: string): number => {
    const m = misses.get(userId)
    if (!m) return 0
    const left = m.since + WRONG_CODE_WINDOW_MS - now()
    if (left <= 0) {
      misses.delete(userId)
      return 0
    }
    return m.count >= WRONG_CODE_LIMIT ? left : 0
  }

  /** Count one code that matched nothing. True when that locked the account. */
  const recordMiss = (userId: string): boolean => {
    const m = misses.get(userId)
    const entry = m && m.since + WRONG_CODE_WINDOW_MS > now() ? m : { count: 0, since: now() }
    entry.count++
    misses.set(userId, entry)
    return entry.count === WRONG_CODE_LIMIT
  }

  /** 302 to Entra through better-auth, back to this page for this code. */
  const signInAgain = async (res: ServerResponse, headers: Headers, code: string) => {
    const back = `${DEVICE_PAGE_PATH}?user_code=${encodeURIComponent(code)}`
    const { headers: set, response } = await api.signInSocial({
      body: {
        provider: ENTRA_PROVIDER_ID,
        callbackURL: back,
        errorCallbackURL: `${back}&signin=failed`,
        disableRedirect: true
      },
      headers,
      returnHeaders: true
    })
    if (!response.url) throw new Error('[hub-auth] Entra sign-in returned no URL')
    res.writeHead(302, {
      location: response.url,
      'set-cookie': set.getSetCookie(),
      'cache-control': 'no-store',
      'referrer-policy': 'same-origin'
    })
    res.end()
  }

  type Resolved =
    | { kind: 'sign-in' }
    | { kind: 'done' }
    | { kind: 'ok'; row: DeviceCodeRow; userId: string; email: string; requestRef: string }

  /**
   * Everything both the page and the forms check, in order. `done` = a page was sent;
   * `sign-in` = the caller must send the browser through Entra (GET) or say so (POST).
   */
  const resolve = async (
    res: ServerResponse,
    headers: Headers,
    code: string,
    step: 'view' | 'approve' | 'deny'
  ): Promise<Resolved> => {
    const ctx = await auth.$context
    const found = await auth.api.getSession({ headers })
    const session = found?.session as Record<string, unknown> | undefined
    const user = found?.user as
      | (Record<string, unknown> & { id: string; email: string })
      | undefined
    if (!session || !user || session.signInMethod !== SIGN_IN_METHOD.sso || isDisabled(user)) {
      return { kind: 'sign-in' }
    }
    const locked = lockedFor(user.id)
    if (locked > 0) {
      securityEvent({
        event: 'auth.device.user_code',
        outcome: 'denied',
        actor: user.id,
        detail: { reason: 'locked' }
      })
      send(
        res,
        429,
        'Too many wrong codes',
        `<p>Try again in ${Math.ceil(locked / 60_000)} minutes.</p>`
      )
      return { kind: 'done' }
    }
    const row = await ctx.adapter.findOne<DeviceCodeRow>({
      model: 'deviceCode',
      where: [{ field: 'userCode', value: code }]
    })
    if (!row) {
      const nowLocked = recordMiss(user.id)
      securityEvent({
        event: 'auth.device.user_code',
        outcome: nowLocked ? 'denied' : 'failure',
        actor: user.id,
        detail: { reason: nowLocked ? 'locked' : 'unknown_code' }
      })
      send(
        res,
        404,
        'Code not found',
        '<p>No sign-in is waiting for that code. Check the code where you started the ' +
          `sign-in; it is valid for ${DEVICE_CODE_TTL_MS / 60_000} minutes.</p>${codeForm()}`
      )
      return { kind: 'done' }
    }
    const requestRef = deviceRequestRef(ctx.secret, row.deviceCode)
    const clientId = row.clientId ?? null
    if (toMs(row.expiresAt) < now()) {
      securityEvent({
        event: 'auth.device.expire',
        outcome: 'failure',
        actor: user.id,
        detail: { clientId, requestRef }
      })
      send(res, 410, 'Code expired', '<p>Start the sign-in again where you started it.</p>')
      return { kind: 'done' }
    }
    if (row.status !== 'pending') {
      send(res, 409, 'Code already used', '<p>This sign-in was already approved or denied.</p>')
      return { kind: 'done' }
    }
    // An Entra sign-in from before this code was issued does not count: every device
    // sign-in is its own Entra sign-in with MFA.
    if (toMs(session.createdAt) < toMs(row.expiresAt) - DEVICE_CODE_TTL_MS) {
      return { kind: 'sign-in' }
    }
    // Claim it for this account (the plugin binds a code to the first account that
    // opens it), then make sure it is this account's.
    await api.deviceVerify({ query: { user_code: code }, headers })
    const claimed = await ctx.adapter.findOne<DeviceCodeRow>({
      model: 'deviceCode',
      where: [{ field: 'id', value: row.id }]
    })
    if (!claimed || claimed.userId !== user.id) {
      securityEvent({
        event: 'auth.device.approve',
        outcome: 'denied',
        actor: user.id,
        detail: { reason: 'other_account', step, clientId, requestRef }
      })
      send(
        res,
        403,
        'Code belongs to another account',
        '<p>This sign-in was opened by another account. Start a new one.</p>'
      )
      return { kind: 'done' }
    }
    return { kind: 'ok', row: claimed, userId: user.id, email: user.email, requestRef }
  }

  const view = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const raw = url.searchParams.get('user_code')
    if (raw === null || raw.trim() === '') {
      send(
        res,
        200,
        'Sign in a device',
        '<p>Enter the code shown where you started the sign-in.</p>' + codeForm()
      )
      return
    }
    const code = normalizeUserCode(raw)
    if (!USER_CODE.test(code)) {
      send(res, 400, 'Not a sign-in code', `<p>Codes look like ABCD-EFGH.</p>${codeForm()}`)
      return
    }
    // Back from a sign-in that did not complete: say so, never loop into Entra again.
    if (url.searchParams.has('signin') || url.searchParams.has('error')) {
      send(
        res,
        401,
        'Sign-in did not complete',
        '<p>Microsoft sign-in was cancelled or refused, so nothing was approved.</p>' +
          restartLink(code)
      )
      return
    }
    const headers = cookieHeaders(req)
    const r = await resolve(res, headers, code, 'view')
    if (r.kind === 'sign-in') return signInAgain(res, headers, code)
    if (r.kind === 'done') return
    const ctx = await auth.$context
    const hubHost = new URL(ctx.baseURL).host
    const client = DEVICE_CLIENTS[r.row.clientId ?? ''] ?? 'An unknown client'
    const hidden = `<input type="hidden" name="user_code" value="${esc(code)}">`
    send(
      res,
      200,
      `Sign in ${client}?`,
      `<p><b>${esc(client)}</b> is asking to sign in to <b>${esc(hubHost)}</b> as ` +
        `<b>${esc(r.email)}</b>.</p>` +
        `<p>Code: <code>${esc(displayCode(code))}</code><br>It must match the code shown ` +
        'where you started the sign-in.</p>' +
        '<p class="warn">Approve only if you started this sign-in yourself, just now. The ' +
        'device gets full access to your account on this hub until it signs out.</p>' +
        `<form method="post" action="${DEVICE_PAGE_PATH}/approve">${hidden}` +
        '<button type="submit">Approve</button></form>' +
        `<form method="post" action="${DEVICE_PAGE_PATH}/deny">${hidden}` +
        '<button type="submit">Deny</button></form>'
    )
  }

  const decide = async (
    req: IncomingMessage,
    res: ServerResponse,
    step: 'approve' | 'deny'
  ): Promise<void> => {
    const ctx = await auth.$context
    const origin = req.headers.origin
    if (
      typeof origin !== 'string' ||
      !origin ||
      origin === 'null' ||
      !ctx.isTrustedOrigin(origin)
    ) {
      securityEvent({
        event: 'authz.denied',
        outcome: 'denied',
        actor: null,
        detail: { reason: origin ? 'untrusted_origin' : 'missing_origin', status: 403 }
      })
      send(res, 403, 'Refused', '<p>This form must be sent from the hub’s own page.</p>')
      return
    }
    const form = await readForm(req)
    const code = normalizeUserCode(form?.get('user_code'))
    if (!form || !USER_CODE.test(code)) {
      send(res, 400, 'Not a sign-in code', codeForm())
      return
    }
    const headers = cookieHeaders(req)
    const r = await resolve(res, headers, code, step)
    if (r.kind === 'done') return
    if (r.kind === 'sign-in') {
      securityEvent({
        event: step === 'approve' ? 'auth.device.approve' : 'auth.device.deny',
        outcome: 'denied',
        actor: null,
        detail: { reason: 'no_fresh_sso_session' }
      })
      send(
        res,
        401,
        'Sign in again',
        '<p>Approving needs a Microsoft sign-in made for this request.</p>' + restartLink(code)
      )
      return
    }
    const detail = { clientId: r.row.clientId ?? null, requestRef: r.requestRef }
    if (step === 'approve') await api.deviceApprove({ body: { userCode: code }, headers })
    else await api.deviceDeny({ body: { userCode: code }, headers })
    securityEvent({
      event: step === 'approve' ? 'auth.device.approve' : 'auth.device.deny',
      outcome: 'success',
      actor: r.userId,
      targetKind: 'user',
      targetId: r.userId,
      detail
    })
    const client = DEVICE_CLIENTS[r.row.clientId ?? ''] ?? 'the device'
    send(
      res,
      200,
      step === 'approve' ? 'Approved' : 'Denied',
      step === 'approve'
        ? `<p>${esc(client)} is signed in. You can close this page.</p>`
        : `<p>${esc(client)} was not signed in. You can close this page.</p>`
    )
  }

  const fail = (res: ServerResponse, err: unknown): void => {
    // A plugin refusal (expired between two checks, already processed, …) has a
    // description meant for people; anything else is a server error and says nothing.
    const description = isAPIError(err)
      ? (err.body as { error_description?: unknown } | undefined)?.error_description
      : undefined
    send(
      res,
      isAPIError(err) ? err.statusCode : 500,
      'Sign-in not completed',
      `<p>${esc(typeof description === 'string' ? description : 'Something went wrong. Start the sign-in again.')}</p>`
    )
  }

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub.invalid')
    const path = url.pathname
    if (path !== DEVICE_PAGE_PATH && !path.startsWith(`${DEVICE_PAGE_PATH}/`)) return false
    let work: Promise<void>
    if (req.method === 'GET' && path === DEVICE_PAGE_PATH) work = view(req, res, url)
    else if (req.method === 'POST' && path === `${DEVICE_PAGE_PATH}/approve`) {
      work = decide(req, res, 'approve')
    } else if (req.method === 'POST' && path === `${DEVICE_PAGE_PATH}/deny`) {
      work = decide(req, res, 'deny')
    } else {
      send(res, 404, 'Not found', '')
      return true
    }
    work.catch((err) => fail(res, err))
    return true
  }
}
