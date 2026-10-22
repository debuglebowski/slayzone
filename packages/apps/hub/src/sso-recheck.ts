/**
 * The hourly Entra re-check (T-12, O-8): on a hub with Entra sign-in, every signed-in
 * account is asked about again by redeeming its stored refresh token — what Entra
 * answers and what each answer does is hub-auth's `entra-recheck.ts`. This module is the
 * schedule and the wiring to the hub's side of revocation (user-access.ts):
 *
 *   - a pass {@link BOOT_RECHECK_DELAY_MS} after boot, then every
 *     {@link RECHECK_INTERVAL_MS};
 *   - never two at once: a tick that finds one running is skipped;
 *   - nothing here throws into the boot or rejects into the process; the timers are
 *     unref'd;
 *   - no Entra sign-in (the desktop app's hub, a password hub): no timer at all.
 *
 * A refusal ends the account's web sessions and open sockets (`endSessions`) — NOT its
 * computers, which only disabling the account in the hub revokes (owner decision O-24:
 * a refusal also follows a password change). A role change closes its sockets so they
 * reconnect with the new role; an account whose web sessions are live counts as signed in.
 *
 * @module server/sso-recheck
 */
import {
  createEntraRecheck,
  type EntraFetch,
  type EntraSsoConfig,
  type HubAuth,
  type RecheckReport
} from '@slayzone/hub-auth/server'
import type { SlayzoneDb } from '@slayzone/platform'
import type { UserAccessRevoker } from './user-access.js'
import { hasLiveWebSession, SSO_WEB_SESSION_LIFETIME } from './web-sessions.js'

/** O-8: hourly. */
export const RECHECK_INTERVAL_MS = 60 * 60 * 1000
/** First pass this long after boot: after the hub listens, out of the boot steps' way. */
export const BOOT_RECHECK_DELAY_MS = 60_000

/** The timer functions the schedule uses; swapped by tests. */
export interface RecheckTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

const realTimers: RecheckTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
}

export interface SsoRecheckHandle {
  /** False on a hub without Entra sign-in: no timer exists. */
  readonly active: boolean
  /** A pass now, unless one is running (then null). Never rejects. */
  runNow(): Promise<RecheckReport | null>
  stop(): void
}

export function startSsoRecheck(opts: {
  auth: HubAuth
  /** Entra sign-in; absent = off. */
  sso: EntraSsoConfig | null | undefined
  db: SlayzoneDb
  revoker: UserAccessRevoker
  timers?: RecheckTimers
  /** Test seam: Entra's token endpoint and key set. */
  fetch?: EntraFetch
  log?: (message: string) => void
}): SsoRecheckHandle {
  if (!opts.sso) {
    return {
      active: false,
      runNow: async () => null,
      stop: () => {
        // Off: no timer was created.
      }
    }
  }
  const log = opts.log ?? ((m: string) => console.log(m))
  const timers = opts.timers ?? realTimers
  const recheck = createEntraRecheck(opts.auth, {
    cfg: opts.sso,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    hasExternalSession: (userId) => hasLiveWebSession(opts.db, userId, SSO_WEB_SESSION_LIFETIME),
    revokeExternal: (userId) => opts.revoker.endSessions(userId),
    onRoleChange: (userId) => opts.revoker.reconnectUser(userId),
    log
  })

  let running = false
  let stopped = false
  const runNow = async (): Promise<RecheckReport | null> => {
    if (stopped) return null
    if (running) {
      log('[entra-recheck] previous pass still running; this tick is skipped')
      return null
    }
    running = true
    try {
      return await recheck.run()
    } catch (err) {
      // `run` never rejects; this is the belt to its braces.
      log(`[entra-recheck] pass failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    } finally {
      running = false
    }
  }
  const tick = (): void => {
    void runNow()
  }
  const unref = (h: unknown): unknown => {
    ;(h as { unref?: () => void } | null)?.unref?.()
    return h
  }
  const boot = unref(timers.setTimeout(tick, BOOT_RECHECK_DELAY_MS))
  const hourly = unref(timers.setInterval(tick, RECHECK_INTERVAL_MS))
  log(
    `[entra-recheck] signed-in accounts are re-checked with Entra: first in ${BOOT_RECHECK_DELAY_MS / 1000}s, then hourly`
  )
  return {
    active: true,
    runNow,
    stop: () => {
      stopped = true
      timers.clearTimeout(boot)
      timers.clearInterval(hourly)
    }
  }
}
