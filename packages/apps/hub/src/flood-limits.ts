/**
 * The hub's own flood limits (T-26) — the entry points an anonymous client reaches that
 * neither better-auth's limiter (hub-auth `rate-limit.ts`, `/api/auth/*` over HTTP) nor
 * the computer gateway's (`/computers`, computer-transport `hub-gateway.ts`) covers.
 * Each is checked at the front door, before the bearer gate and before any per-request
 * work, keyed on the client address the hub resolved (T-22, an IPv6 one as its /64).
 *
 *   - `POST /api/auth/web-login` — OUR password sign-in for the web shell. It signs in
 *     in process (`auth.api.signInEmail`), which better-auth never rate-limits, so
 *     without this it would be the one password route open to guessing. Same size as
 *     better-auth's `/sign-in/*`: 10 a minute.
 *   - `POST /api/auth/break-glass` — redeeming an operator's grant (break-glass.ts).
 *     Needs a grant opened on the hub machine and its verifier, and an operator redeems
 *     once; 10 per 10 minutes.
 *   - `/trpc` upgrades — anyone may open one (the origin guard admits a non-browser
 *     client) and authenticates inside it, so the upgrade cannot tell a user from a
 *     flood: at most 120 upgrades a minute and 64 open sockets per address. Six users'
 *     desktop windows, web tabs and CLIs behind one NAT stay far below either; a client
 *     refused retries with backoff (tRPC's ws link).
 *   - `GET /api/auth/web-sso` — the web shell's Entra sign-in (T-13, hub-auth
 *     `web-sign-in.ts`). It starts Entra in process (`auth.api.signInSocial`, an OAuth
 *     state written per request), which better-auth never rate-limits — so the same
 *     budget as its `/sign-in/*`, doubled: one sign-in is two requests here (the start
 *     and the return leg). 20 a minute.
 *   - `POST /api/auth/web-session`, `POST /api/auth/web-logout` — the web shell's
 *     session status and sign-out (T-13, web-session-routes.ts): open like better-auth's
 *     `get-session` / `sign-out`, so its default for those, 300 a minute each.
 *   - `GET /device` — the device sign-in page (T-14, hub-auth `device-page.ts`). Without
 *     a fresh Entra session it starts Entra in process (`signInSocial`, as web-sso), so
 *     web-sso's budget: 20 a minute. Covers every leg, query or not (open, return, retry).
 *   - `POST /device/approve`, `POST /device/deny` — its cookie-authenticated forms. They
 *     never start Entra; one shared budget like the session posts, 300 a minute (T-110).
 *   - `GET /api/auth/app-sso` — the native app's Microsoft sign-in (hub-auth
 *     `app-sign-in.ts`): starts Entra in process like web-sso, start and return leg on one
 *     path, so web-sso's budget: 20 a minute.
 *   - `POST /api/auth/app-sso/confirm` — its confirm page's form; never starts Entra, so
 *     the device forms' budget: 300 a minute.
 *   - `POST /api/auth/app-sso/token` — the app's code exchange, one per sign-in: 10 a
 *     minute, better-auth's `/sign-in/*` size. Its codes are 256-bit and single-use, so
 *     the limit bounds work, not guessing.
 *
 * Deliberately NOT limited here (see the PR for T-26):
 *   - `/health`: answered from memory, and the front end's health probe polls it — a
 *     refused probe would take the hub out of rotation;
 *   - the web shell's document and assets: static files, and one page load is dozens of
 *     requests — the edge (WAF) limits those;
 *   - everything behind the bearer gate: refusing by address before the gate would also
 *     refuse the signed-in users who share that address, and an anonymous request there
 *     costs one indexed lookup (better-auth's own routes are limited by better-auth).
 *
 * ON ONLY WHERE OTHER MACHINES CAN REACH THE HUB (`server.ts`: `boot.reachable`). The
 * desktop app's hub — login off, loopback, its one user — is never limited; B1 makes
 * "reachable" imply "login required", so a limit never meets a hub without accounts.
 *
 * @module hub/flood-limits
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { clientAddress } from '@slayzone/platform/client-address'
import {
  addressBucket,
  createFixedWindowLimiter,
  createRateLimitAudit,
  type RateRule
} from '@slayzone/platform/rate-limit'
import {
  APP_SIGN_IN_CONFIRM_PATH,
  APP_SIGN_IN_PATH,
  APP_SIGN_IN_TOKEN_PATH,
  DEVICE_PAGE_PATH,
  WEB_SIGN_IN_PATH
} from '@slayzone/hub-auth/server'
import { BREAK_GLASS_PATH } from './break-glass'
import { WEB_LOGOUT_PATH, WEB_SESSION_STATUS_PATH } from './web-sessions'

/** Per client address. */
export const HUB_FLOOD_RULES = {
  webLogin: { max: 10, windowMs: 60_000 },
  breakGlassRedeem: { max: 10, windowMs: 10 * 60_000 },
  trpcUpgrades: { max: 120, windowMs: 60_000 },
  // T-13: the web shell's sign-in and session routes.
  webSso: { max: 20, windowMs: 60_000 },
  webSession: { max: 300, windowMs: 60_000 },
  webLogout: { max: 300, windowMs: 60_000 },
  // T-110: the device sign-in page (start leg) and its approve/deny forms.
  deviceStart: { max: 20, windowMs: 60_000 },
  deviceDecide: { max: 300, windowMs: 60_000 },
  // The native app's Microsoft sign-in: start + return legs, confirm form, code exchange.
  appSsoStart: { max: 20, windowMs: 60_000 },
  appSsoConfirm: { max: 300, windowMs: 60_000 },
  appSsoToken: { max: 10, windowMs: 60_000 }
} as const satisfies Record<string, RateRule>

/** Open `/trpc` sockets one client address may hold. */
export const TRPC_SOCKETS_PER_ADDRESS = 64

/** The HTTP routes limited here: `METHOD path` → limit name and rule. */
const HTTP_RULES = new Map<string, { limit: string; rule: RateRule }>([
  ['POST /api/auth/web-login', { limit: 'http.web_login', rule: HUB_FLOOD_RULES.webLogin }],
  [
    `POST ${BREAK_GLASS_PATH}`,
    { limit: 'http.break_glass_redeem', rule: HUB_FLOOD_RULES.breakGlassRedeem }
  ],
  [`GET ${WEB_SIGN_IN_PATH}`, { limit: 'http.web_sso', rule: HUB_FLOOD_RULES.webSso }],
  [
    `POST ${WEB_SESSION_STATUS_PATH}`,
    { limit: 'http.web_session', rule: HUB_FLOOD_RULES.webSession }
  ],
  [`POST ${WEB_LOGOUT_PATH}`, { limit: 'http.web_logout', rule: HUB_FLOOD_RULES.webLogout }],
  [`GET ${DEVICE_PAGE_PATH}`, { limit: 'http.device_start', rule: HUB_FLOOD_RULES.deviceStart }],
  // One limit name, so approve and deny share a bucket.
  [
    `POST ${DEVICE_PAGE_PATH}/approve`,
    { limit: 'http.device_decide', rule: HUB_FLOOD_RULES.deviceDecide }
  ],
  [
    `POST ${DEVICE_PAGE_PATH}/deny`,
    { limit: 'http.device_decide', rule: HUB_FLOOD_RULES.deviceDecide }
  ],
  [`GET ${APP_SIGN_IN_PATH}`, { limit: 'http.app_sso_start', rule: HUB_FLOOD_RULES.appSsoStart }],
  [
    `POST ${APP_SIGN_IN_CONFIRM_PATH}`,
    { limit: 'http.app_sso_confirm', rule: HUB_FLOOD_RULES.appSsoConfirm }
  ],
  [
    `POST ${APP_SIGN_IN_TOKEN_PATH}`,
    { limit: 'http.app_sso_token', rule: HUB_FLOOD_RULES.appSsoToken }
  ]
])

export type TrpcUpgradeAdmission =
  | {
      ok: true
      /** Count `ws` against its address until it closes. Call in the upgrade callback. */
      track(ws: { once(event: 'close', listener: () => void): unknown }): void
    }
  | { ok: false; status: 429; retryAfterSec: number; limit: string }

export interface HubFloodGuard {
  readonly enabled: boolean
  /** Refuse `req` with 429 when it is over its limit. True when the response is written. */
  refuseRequest(req: IncomingMessage, res: ServerResponse): boolean
  /** Whether to complete a `/trpc` upgrade. Ask before `handleUpgrade`, in the same tick. */
  admitTrpcUpgrade(req: IncomingMessage): TrpcUpgradeAdmission
}

const TRACK_NOTHING: TrpcUpgradeAdmission = { ok: true, track: () => undefined }

export function createHubFloodGuard(opts: {
  /** `boot.reachable`: off on a hub no other machine can reach. */
  enabled: boolean
  now?: () => number
}): HubFloodGuard {
  const limiter = createFixedWindowLimiter({ now: opts.now })
  const audit = createRateLimitAudit({ now: opts.now })
  const trpcOpen = new Map<string, number>()

  return {
    enabled: opts.enabled,
    refuseRequest(req, res) {
      if (!opts.enabled) return false
      const path = (req.url ?? '').split('?')[0]
      const entry = HTTP_RULES.get(`${req.method ?? 'GET'} ${path}`)
      if (!entry) return false
      const address = clientAddress(req)
      const verdict = limiter.consume(`${entry.limit}|${addressBucket(address)}`, entry.rule)
      if (verdict.allowed) return false
      audit({
        limit: entry.limit,
        address,
        route: `${req.method} ${path}`,
        max: entry.rule.max,
        windowSec: entry.rule.windowMs / 1000,
        retryAfterSec: verdict.retryAfterSec
      })
      if (!res.headersSent) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(verdict.retryAfterSec)
        })
        res.end(JSON.stringify({ ok: false, error: 'Too many requests. Try again later.' }))
      }
      return true
    },
    admitTrpcUpgrade(req) {
      if (!opts.enabled) return TRACK_NOTHING
      const address = clientAddress(req)
      const bucket = addressBucket(address)
      const refuse = (limit: string, max: number, retryAfterSec: number, windowSec?: number) => {
        audit({
          limit,
          address,
          route: 'WS /trpc',
          max,
          retryAfterSec,
          ...(windowSec === undefined ? {} : { windowSec })
        })
        return { ok: false as const, status: 429 as const, retryAfterSec, limit }
      }
      if ((trpcOpen.get(bucket) ?? 0) >= TRPC_SOCKETS_PER_ADDRESS) {
        return refuse('trpc.sockets_per_address', TRPC_SOCKETS_PER_ADDRESS, 5)
      }
      const rule = HUB_FLOOD_RULES.trpcUpgrades
      const verdict = limiter.consume(`trpc.upgrades|${bucket}`, rule)
      if (!verdict.allowed) {
        return refuse('trpc.upgrades', rule.max, verdict.retryAfterSec, rule.windowMs / 1000)
      }
      return {
        ok: true,
        track(ws) {
          trpcOpen.set(bucket, (trpcOpen.get(bucket) ?? 0) + 1)
          ws.once('close', () => {
            const left = (trpcOpen.get(bucket) ?? 1) - 1
            if (left > 0) trpcOpen.set(bucket, left)
            else trpcOpen.delete(bucket)
          })
        }
      }
    }
  }
}

/**
 * Refuse a WebSocket upgrade on the raw socket — before `handleUpgrade`, so nothing is
 * allocated for it — with the status and when to retry.
 */
export function refuseUpgrade(socket: Duplex, status: 429 | 503, retryAfterSec: number): void {
  const reason = status === 429 ? 'Too Many Requests' : 'Service Unavailable'
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nRetry-After: ${retryAfterSec}\r\n` +
        'Connection: close\r\nContent-Length: 0\r\n\r\n'
    )
  } catch {
    // The client may already be gone; destroying is all that is left.
  }
  socket.destroy()
}
