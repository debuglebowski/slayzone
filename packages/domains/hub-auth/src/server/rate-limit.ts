/**
 * better-auth's rate limiter for a hub other machines can reach (T-26).
 *
 * ON BY CONFIG, NEVER BY NODE_ENV. better-auth 1.6.23 turns its limiter on only when
 * `NODE_ENV=production` (`create-context.mjs`: `enabled: options.rateLimit?.enabled ??
 * isProduction`). `auth.ts` always passes `enabled` as a boolean, so the hub's choice
 * — on where other machines can reach it, off on the desktop app's loopback hub — is
 * the same whatever NODE_ENV the process has.
 *
 * KEY. better-auth keys a request on `<client ip>|<path below /api/auth>`. The ip comes
 * only from `CLIENT_ADDRESS_HEADER`, which the hub overwrites on every request with the
 * address it resolved from the TCP peer and its trusted front ends (T-22) — a client's
 * own `X-Forwarded-For` cannot move it. Only HTTP requests are limited; an in-process
 * `auth.api.*` call (the hub's own session checks) never is.
 *
 * STORAGE: memory, per instance ({@link createAuthRateLimitStorage}). A hub is one
 * node, so nothing else needs the counts, and a restart forgetting windows of minutes
 * costs nothing; the database store would add a sqlite write to every auth request.
 * Ours rather than better-auth's own memory store for two reasons: better-auth's
 * restarts its window at every allowed request, so the device-token poll (every 5 s,
 * for up to 10 minutes) would be refused once its count reached the cap however slow
 * it went; and a refusal here writes the `hub.rate_limit` audit line (once per path and
 * address per minute), which better-auth's own refusal — answered before any endpoint
 * or hook runs — never would. Fixed windows, see `@slayzone/platform/rate-limit`.
 *
 * SIZES (per client address; 6 users who may all sit behind one office NAT, 7-day
 * sessions — so a person signs in about weekly):
 *   - `/sign-in/*` (Entra start, password sign-in where it is on) and `/callback/*`
 *     (Entra's redirect back): 10 a minute. One sign-in is one of each.
 *   - `/device/code`: 10 per 10 minutes — one per CLI/desktop sign-in, and with at most
 *     100 codes pending hub-wide (T-14) no single address can take them all.
 *   - `/device/token`: 150 a minute — a waiting client polls every 5 s (12 a minute), so
 *     a dozen sign-ins at once from one address still pass.
 *   - every other path: 300 a minute each (`get-session`, `sign-out`, …).
 *   - better-auth's own rules still apply where none of these match: `/sign-up`,
 *     `/change-password`, `/change-email` 3 per 10 s; the reset/verification mails 3 a
 *     minute.
 *
 * @module hub-auth/rate-limit
 */
import {
  addressBucket,
  createFixedWindowLimiter,
  createRateLimitAudit
} from '@slayzone/platform/rate-limit'

/** Seconds, as better-auth takes them. */
interface AuthRateRule {
  window: number
  max: number
}

/** Every `/api/auth` path no rule below names: per path, per address. */
export const AUTH_RATE_LIMIT_DEFAULT: AuthRateRule = { window: 60, max: 300 }

/** Paths below `/api/auth` (better-auth's glob: `*` is one path segment). */
export const AUTH_RATE_LIMIT_RULES: Readonly<Record<string, AuthRateRule>> = {
  '/sign-in/*': { window: 60, max: 10 },
  '/callback/*': { window: 60, max: 10 },
  '/device/code': { window: 600, max: 10 },
  '/device/token': { window: 60, max: 150 }
}

/** better-auth's `BetterAuthRateLimitStorage`, structurally (core does not export it). */
export interface AuthRateLimitStorage {
  get: (key: string) => Promise<{ key: string; count: number; lastRequest: number } | null>
  set: (key: string, value: { key: string; count: number; lastRequest: number }) => Promise<void>
  consume: (
    key: string,
    rule: AuthRateRule
  ) => Promise<{ allowed: boolean; retryAfter: number | null }>
}

/**
 * The limiter's storage: fixed windows in memory, and one `hub.rate_limit` line when a
 * path refuses an address (at most one per path and address per minute). better-auth
 * calls only `consume`; `get`/`set` exist because its type requires them, and are
 * inert.
 */
export function createAuthRateLimitStorage(
  opts: { now?: () => number } = {}
): AuthRateLimitStorage {
  const limiter = createFixedWindowLimiter(opts)
  const audit = createRateLimitAudit(opts)
  return {
    get: async () => null,
    set: async () => undefined,
    consume: async (key, rule) => {
      // better-auth's key is `<ip>|<path>` (an IPv6 address already as its /64); an
      // address it could not resolve is `no-trusted-ip`.
      const bar = key.indexOf('|')
      const ip = bar === -1 ? key : key.slice(0, bar)
      const path = bar === -1 ? '' : key.slice(bar + 1)
      const verdict = limiter.consume(`${addressBucket(ip)}|${path}`, {
        max: rule.max,
        windowMs: rule.window * 1000
      })
      if (verdict.allowed) return { allowed: true, retryAfter: null }
      audit({
        limit: `auth${path}`,
        address: ip,
        route: `/api/auth${path}`,
        max: rule.max,
        windowSec: rule.window,
        retryAfterSec: verdict.retryAfterSec
      })
      return { allowed: false, retryAfter: verdict.retryAfterSec }
    }
  }
}

/** The `rateLimit` option `auth.ts` hands better-auth. `enabled` is always a boolean. */
export function hubAuthRateLimit(enabled: boolean) {
  return {
    enabled,
    ...AUTH_RATE_LIMIT_DEFAULT,
    customRules: { ...AUTH_RATE_LIMIT_RULES },
    customStorage: createAuthRateLimitStorage()
  }
}
