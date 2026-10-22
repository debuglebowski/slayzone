/**
 * Flood limits for a hub other machines can reach (T-26): fixed-window counters keyed
 * on the client address, and the audit line a refusal writes — once per address and
 * limit per window, never once per request or socket.
 *
 * WHY FIXED WINDOWS. A window opens at the first event for a key and closes `windowMs`
 * later, whatever happens inside it. better-auth's built-in memory store instead
 * restarts its window at every ALLOWED request, so a client that polls more often than
 * the window (the device-token poll every 5 s) never sees it close and is refused once
 * its count reaches the cap — a lock-out of exactly the steady, legitimate caller.
 *
 * KEYS. {@link addressBucket}: an IPv4 address as is, an IPv6 address as its /64 —
 * one host holds a whole /64, so a per-address limit keyed on the full address is
 * bypassed by rotating the last 64 bits (better-auth collapses IPv6 the same way).
 *
 * BOUNDED. At most `maxKeys` keys are held: closed windows are dropped first, then
 * the oldest. Dropping a key only forgets its count, so an attacker cycling keys can make
 * the limiter more lenient for itself, never grow the hub's memory.
 *
 * Single process, in memory: a hub is one node, and a restart forgetting counts that
 * live minutes is harmless. Lean leaf (node builtins, `client-address`, `security-log`),
 * the `@slayzone/platform/rate-limit` subpath.
 *
 * @module platform/rate-limit
 */
import { isIP } from 'node:net'
import { canonicalAddress } from './client-address'
import { securityEvent } from './security-log'

/** At most `max` events per key in each window of `windowMs`. */
export interface RateRule {
  max: number
  windowMs: number
}

export type RateVerdict = { allowed: true } | { allowed: false; retryAfterSec: number }

export interface FixedWindowLimiter {
  /** Count one event for `key` if it is under `rule.max` in its window; refuse otherwise. */
  consume(key: string, rule: RateRule): RateVerdict
  /** Whether `key` is still under `rule.max`, without counting anything. */
  check(key: string, rule: RateRule): RateVerdict
  /** Count one event for `key` whatever its count (a strike against it). */
  hit(key: string, rule: RateRule): void
  /** Keys currently held. */
  size(): number
}

export interface LimiterOptions {
  /** Most keys held at once. Default 10 000. */
  maxKeys?: number
  /** Clock (tests). */
  now?: () => number
}

interface Window {
  count: number
  endsAt: number
}

export function createFixedWindowLimiter(opts: LimiterOptions = {}): FixedWindowLimiter {
  const maxKeys = opts.maxKeys ?? 10_000
  const now = opts.now ?? (() => Date.now())
  const windows = new Map<string, Window>()

  // Full: drop every closed window, then — still over 90% — the oldest (Map order is
  // insertion order, and a window that reopens is re-inserted). Down to 90% so the
  // scan runs once per tenth of `maxKeys` new keys, not on every one.
  const prune = (t: number): void => {
    if (windows.size < maxKeys) return
    for (const [key, w] of windows) if (w.endsAt <= t) windows.delete(key)
    const target = Math.floor(maxKeys * 0.9)
    for (const key of windows.keys()) {
      if (windows.size <= target) break
      windows.delete(key)
    }
  }
  /** The open window for `key`, or null when it has none (or it closed). */
  const open = (key: string, t: number): Window | null => {
    const w = windows.get(key)
    if (!w) return null
    if (w.endsAt > t) return w
    windows.delete(key)
    return null
  }
  const start = (key: string, rule: RateRule, t: number): void => {
    prune(t)
    windows.set(key, { count: 1, endsAt: t + rule.windowMs })
  }
  const refused = (w: Window, t: number): RateVerdict => ({
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil((w.endsAt - t) / 1000))
  })

  return {
    consume(key, rule) {
      const t = now()
      const w = open(key, t)
      if (!w) {
        if (rule.max < 1) return { allowed: false, retryAfterSec: Math.ceil(rule.windowMs / 1000) }
        start(key, rule, t)
        return { allowed: true }
      }
      if (w.count >= rule.max) return refused(w, t)
      w.count += 1
      return { allowed: true }
    },
    check(key, rule) {
      const t = now()
      const w = open(key, t)
      return w && w.count >= rule.max ? refused(w, t) : { allowed: true }
    },
    hit(key, rule) {
      const t = now()
      const w = open(key, t)
      if (w) w.count += 1
      else start(key, rule, t)
    },
    size: () => windows.size
  }
}

/**
 * The key a client address is limited under: IPv4 as is, IPv6 as its /64 network
 * (`2001:db8:1:2::/64`), anything else (no address, a non-IP peer) as given, or
 * `unknown`.
 */
export function addressBucket(address: string | null | undefined): string {
  if (!address) return 'unknown'
  const canonical = canonicalAddress(address)
  if (!canonical) return address
  if (isIP(canonical) === 4) return canonical
  const halves = canonical.split('::')
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

/** What a refusal line says: which limit, for whom, and how long until it frees up. */
export interface RateLimitRefusal {
  /** Stable name of the limit, e.g. `computers.pending_per_address`. */
  limit: string
  /** The client address refused (the line's `ip`). */
  address: string | null
  /** `METHOD /path` or `WS /path`. */
  route: string | null
  max: number
  /** The limit's window, when it has one (a concurrency cap has none). */
  windowSec?: number
  retryAfterSec?: number
}

/**
 * A `hub.rate_limit` writer that writes at most one line per limit and address bucket
 * per `windowMs` (default 60 s): a flood is one line per minute per source, never a
 * line per refused request. Returns whether it wrote one.
 */
export function createRateLimitAudit(
  opts: { windowMs?: number } & LimiterOptions = {}
): (refusal: RateLimitRefusal) => boolean {
  const seen = createFixedWindowLimiter(opts)
  const rule: RateRule = { max: 1, windowMs: opts.windowMs ?? 60_000 }
  return (refusal) => {
    if (!seen.consume(`${refusal.limit}|${addressBucket(refusal.address)}`, rule).allowed) {
      return false
    }
    securityEvent({
      event: 'hub.rate_limit',
      outcome: 'denied',
      actor: null,
      ip: refusal.address,
      route: refusal.route,
      targetKind: 'hub',
      detail: {
        limit: refusal.limit,
        max: refusal.max,
        ...(refusal.windowSec === undefined ? {} : { windowSec: refusal.windowSec }),
        ...(refusal.retryAfterSec === undefined ? {} : { retryAfterSec: refusal.retryAfterSec }),
        // How often this source may be named here: once per limit per window.
        auditWindowSec: Math.round(rule.windowMs / 1000)
      }
    })
    return true
  }
}
