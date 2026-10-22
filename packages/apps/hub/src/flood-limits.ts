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
import { BREAK_GLASS_PATH } from './break-glass'

/** Per client address. */
export const HUB_FLOOD_RULES = {
  webLogin: { max: 10, windowMs: 60_000 },
  breakGlassRedeem: { max: 10, windowMs: 10 * 60_000 },
  trpcUpgrades: { max: 120, windowMs: 60_000 }
} as const satisfies Record<string, RateRule>

/** Open `/trpc` sockets one client address may hold. */
export const TRPC_SOCKETS_PER_ADDRESS = 64

/** The HTTP routes limited here: `METHOD path` → limit name and rule. */
const HTTP_RULES = new Map<string, { limit: string; rule: RateRule }>([
  ['POST /api/auth/web-login', { limit: 'http.web_login', rule: HUB_FLOOD_RULES.webLogin }],
  [
    `POST ${BREAK_GLASS_PATH}`,
    { limit: 'http.break_glass_redeem', rule: HUB_FLOOD_RULES.breakGlassRedeem }
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
