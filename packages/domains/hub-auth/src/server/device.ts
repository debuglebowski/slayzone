/**
 * Device sign-in (T-14): the CLI (`slay hub login`), the desktop app and an agent's
 * `slay` on a Cloud Device sign in to an Entra hub WITHOUT a password and without a
 * browser of their own — OAuth 2.0 Device Authorization Grant (RFC 8628), through
 * better-auth's `deviceAuthorization` plugin.
 *
 *   1. client  `POST /api/auth/device/code {client_id}` → device code (secret, stays on
 *              the client), user code (shown to the person), `verification_uri`
 *              (`https://<public address>/device`), expiry, polling interval.
 *   2. person  opens the URI in ANY browser, signs in through Entra (T-09: tenant, app
 *              role, `amr` ∋ `mfa`), sees which client asks, approves or denies
 *              (`device-page.ts`, served by the hub).
 *   3. client  polls `POST /api/auth/device/token {grant_type, device_code, client_id}`
 *              → `authorization_pending` / `slow_down` / `access_denied` /
 *              `expired_token`, or once approved `{access_token}`: a better-auth
 *              SESSION token, the same bearer `sign-in/email` hands out, with the hub's
 *              normal session lifetime. The plugin consumes the code in the same step.
 *
 * WHAT THIS MODULE ADDS TO THE PLUGIN:
 *   - only this hub's clients (`DEVICE_CLIENTS`); codes live 10 minutes, poll every 5s
 *     (the plugin answers `slow_down` to anyone faster);
 *   - the plugin's browser-leg endpoints (`/device`, `/device/approve`, `/device/deny`)
 *     are closed over HTTP: they accept ANY session, a bearer included, so a device
 *     token could approve the next device code and renew itself forever, and a password
 *     session (break-glass, no MFA) could mint a token. Only the hub's approval page
 *     calls them, in process, after its own checks (`device-page.ts`);
 *   - every session records how it was made (`session.signInMethod`: `sso` for an Entra
 *     callback that passed the checks, `device` for a device token, null otherwise), so
 *     the page can demand an Entra sign-in made AFTER the code was issued;
 *   - expired codes are swept on every new request and at most
 *     {@link MAX_PENDING_DEVICE_CODES} may be outstanding, so the open endpoint cannot
 *     grow the database without bound;
 *   - audit lines (`auth.device.*`, and `auth.signin` method `device` for the token),
 *     correlated by {@link deviceRequestRef}. No code or token is ever written.
 *
 * Installed only on a hub with Entra sign-in (auth.ts): a password hub keeps
 * `sign-in/email` and has none of these routes.
 *
 * @module hub-auth/device
 */
import { createHmac } from 'node:crypto'
import { securityEvent } from '@slayzone/platform/security-log'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { deviceAuthorization } from 'better-auth/plugins'
import { isPassedEntraSignIn } from './entra'

/** The clients that may ask for a device code, with the name the approval page shows. */
export const DEVICE_CLIENTS: Readonly<Record<string, string>> = {
  'slayzone-cli': 'SlayZone CLI (slay)',
  'slayzone-desktop': 'SlayZone desktop app'
}

/** Lifetime of a device + user code (RFC 8628 `expires_in`). */
export const DEVICE_CODE_TTL_MS = 10 * 60_000

/** Minimum seconds between two polls of one device code (RFC 8628 `interval`). */
export const DEVICE_POLL_INTERVAL_SEC = 5

/** The approval page, relative to the hub's public address (`verification_uri`). */
export const DEVICE_PAGE_PATH = '/device'

/** Outstanding (unexpired) device codes allowed at once on one hub. */
export const MAX_PENDING_DEVICE_CODES = 100

/** `session.signInMethod` values. Null on every other session (password, older rows). */
export const SIGN_IN_METHOD = { sso: 'sso', device: 'device' } as const

/** Id of the plugin that guards and audits better-auth's `device-authorization`. */
export const DEVICE_PLUGIN_ID = 'slayzone-device-sign-in'

/** better-auth's browser-leg endpoints: for the hub's own page, in process, only. */
const BROWSER_LEG = new Set(['/device', '/device/approve', '/device/deny'])

/**
 * A stable handle for one device request in the audit log — a keyed hash of its device
 * code, so the issue, approve and token lines correlate without writing the code.
 */
export function deviceRequestRef(secret: string, deviceCode: string): string {
  return createHmac('sha256', secret).update(`device:${deviceCode}`).digest('hex').slice(0, 16)
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** An endpoint's result split into its JSON body and, for a thrown `APIError`, the error. */
function outcomeOf(returned: unknown): { body: Record<string, unknown>; error: string | null } {
  const r = asRecord(returned)
  if (r && typeof r.statusCode === 'number' && r.statusCode >= 400) {
    const body = asRecord(r.body) ?? {}
    return { body, error: str(body.error) ?? str(body.code) ?? 'error' }
  }
  // `ctx.json()` answers the bare object to an in-process call, a tagged one to HTTP.
  return { body: (r?._flag === 'json' ? asRecord(r.body) : r) ?? {}, error: null }
}

const knownClient = (v: unknown): string | null => {
  const id = str(v)
  return id && Object.hasOwn(DEVICE_CLIENTS, id) ? id : null
}

/** Before `/device/code`: drop expired codes, then refuse past the outstanding cap. */
const sweepAndCap = createAuthMiddleware(async (ctx) => {
  const adapter = ctx.context.adapter
  const swept = await adapter.deleteMany({
    model: 'deviceCode',
    where: [{ field: 'expiresAt', operator: 'lt', value: new Date() }]
  })
  if (swept > 0) {
    securityEvent({
      event: 'auth.device.expire',
      outcome: 'failure',
      actor: null,
      detail: { swept }
    })
  }
  if ((await adapter.count({ model: 'deviceCode' })) >= MAX_PENDING_DEVICE_CODES) {
    securityEvent({
      event: 'auth.device.code',
      outcome: 'denied',
      actor: null,
      detail: { reason: 'too_many_pending', clientId: knownClient(asRecord(ctx.body)?.client_id) }
    })
    throw new APIError('TOO_MANY_REQUESTS', {
      error: 'temporarily_unavailable',
      error_description: 'Too many sign-ins are waiting on this hub. Try again in a few minutes.'
    })
  }
})

/** After `/device/code`: one line per code issued or refused. */
const auditCode = createAuthMiddleware(async (ctx) => {
  try {
    const { body, error } = outcomeOf(ctx.context.returned)
    if (error) {
      // The cap's refusal wrote its own line above.
      if (error === 'temporarily_unavailable') return
      securityEvent({
        event: 'auth.device.code',
        outcome: 'denied',
        actor: null,
        detail: { reason: error }
      })
      return
    }
    const deviceCode = str(body.device_code)
    securityEvent({
      event: 'auth.device.code',
      outcome: 'success',
      actor: null,
      detail: {
        clientId: knownClient(asRecord(ctx.body)?.client_id),
        requestRef: deviceCode ? deviceRequestRef(ctx.context.secret, deviceCode) : null
      }
    })
  } catch {
    // An audit line must never fail the request it reports.
  }
})

/** After `/device/token`: the token issued, or why not (polling noise is not logged). */
const auditToken = createAuthMiddleware(async (ctx) => {
  try {
    const { error } = outcomeOf(ctx.context.returned)
    const input = asRecord(ctx.body)
    const deviceCode = str(input?.device_code)
    const detail = {
      clientId: knownClient(input?.client_id),
      requestRef: deviceCode ? deviceRequestRef(ctx.context.secret, deviceCode) : null
    }
    if (!error) {
      const userId = str(asRecord(asRecord(ctx.context.newSession)?.user)?.id)
      securityEvent({
        event: 'auth.signin',
        outcome: 'success',
        actor: userId,
        detail: { method: 'device', ...detail }
      })
      return
    }
    // Still waiting; or refused by the person (`auth.device.deny` has it); or a disabled
    // account (account.ts wrote that `auth.signin` denied line).
    if (
      ['authorization_pending', 'slow_down', 'access_denied', 'ACCOUNT_DISABLED'].includes(error)
    ) {
      return
    }
    if (error === 'expired_token') {
      securityEvent({ event: 'auth.device.expire', outcome: 'failure', actor: null, detail })
      return
    }
    securityEvent({
      event: 'auth.signin',
      outcome: 'failure',
      actor: null,
      detail: { method: 'device', reason: error.slice(0, 80), ...detail }
    })
  } catch {
    // An audit line must never fail the request it reports.
  }
})

/** Closes the plugin's browser-leg endpoints to HTTP; the hub's page calls them in process. */
const closeBrowserLeg = createAuthMiddleware(async (ctx) => {
  if (ctx.request) throw new APIError('NOT_FOUND')
})

const pathIs =
  (...paths: string[]) =>
  (ctx: { path?: string }): boolean =>
    paths.includes(ctx.path ?? '')

function deviceGuard() {
  return {
    id: DEVICE_PLUGIN_ID,
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => BROWSER_LEG.has(ctx.path ?? ''),
          handler: closeBrowserLeg
        },
        { matcher: pathIs('/device/code'), handler: sweepAndCap }
      ],
      after: [
        { matcher: pathIs('/device/code'), handler: auditCode },
        { matcher: pathIs('/device/token'), handler: auditToken }
      ]
    }
  } satisfies BetterAuthPlugin
}

/** The plugins device sign-in installs (auth.ts, Entra hubs only). */
export function deviceSignIn() {
  return [
    deviceAuthorization({
      expiresIn: `${DEVICE_CODE_TTL_MS / 60_000}m`,
      interval: `${DEVICE_POLL_INTERVAL_SEC}s`,
      verificationUri: DEVICE_PAGE_PATH,
      validateClient: (clientId) => Object.hasOwn(DEVICE_CLIENTS, clientId)
    }),
    deviceGuard()
  ]
}

/**
 * `databaseHooks.session.create.before` (last, after the disabled and role steps):
 * record how the session was made, see `SIGN_IN_METHOD`. A session from anywhere
 * else keeps null.
 */
export async function markSignInMethod(
  session: Record<string, unknown>,
  ctx: { path?: string } | null
): Promise<{ data: Record<string, unknown> } | undefined> {
  const method = (await isPassedEntraSignIn())
    ? SIGN_IN_METHOD.sso
    : ctx?.path === '/device/token'
      ? SIGN_IN_METHOD.device
      : null
  return method ? { data: { ...session, signInMethod: method } } : undefined
}
