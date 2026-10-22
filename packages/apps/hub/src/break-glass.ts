/**
 * Break-glass v2 (owner decisions O-9, O-23): how an operator gets ADMIN access to a hub
 * whose sign-in is down (Entra) — no restart, no env change, no password, nothing secret
 * on disk. Replaces v1 (T-10: `ENABLE_PASSWORD=1` + restart, a password account and its
 * password in `<ROOT>/hub.break-glass.json`). `SLAYZONE_HUB_ENABLE_PASSWORD` is the plain
 * password switch again and has nothing to do with break-glass.
 *
 * THE FLOW
 *   1. Laptop: `slay hub break-glass start <url>` draws a random VERIFIER, keeps it in that
 *      process's memory, and prints its CHALLENGE (base64url SHA-256) inside the command
 *      to run on the hub machine.
 *   2. Hub machine (Azure Run Command, as root or the hub's OS user):
 *      `slayzone-hub break-glass open --challenge <C> --ttl 30m` → the local socket
 *      (hub-admin-socket.ts) → {@link BreakGlass.grant}: a GRANT held in this process's
 *      memory for {@link BREAK_GLASS_GRANT_TTL_MS}. Replaces a grant still pending; refused
 *      while a session is open.
 *   3. Laptop: `POST /api/auth/break-glass { verifier }` → {@link BreakGlass.redeem}: the
 *      verifier must hash to the challenge. The grant is consumed — once — the break-glass
 *      account (hub-auth `break-glass.ts`) is enabled as admin, and a session token
 *      (`szbg_…`) comes back, valid for the TTL from now. Only its SHA-256 is kept, in
 *      memory.
 *   4. The session manages accounts and computers over REST, nothing else
 *      (rest-auth.ts `BREAK_GLASS_ROUTES`; `/trpc` refuses it, hub-trpc-context.ts).
 *   5. It ends at its TTL, on `slayzone-hub break-glass end`, on `DELETE
 *      /api/auth/break-glass` from the session itself, or when the hub stops: the token is
 *      forgotten first, then the account is closed (disabled, `user` again, everything it
 *      holds revoked through `revokeUser`, T-12). A crash leaves only the account enabled
 *      — with no credential anyone holds — and the next boot closes it
 *      ({@link BreakGlass.closeAtBoot}).
 *
 * WHY AZURE'S COPY OF THE RUN COMMAND OUTPUT IS WORTHLESS. Run Command keeps the script
 * and its output. Both hold the challenge (a hash), the grant's reference and its expiry —
 * never a secret: redeeming needs the verifier, which never left the laptop. Even someone
 * who also captured the verifier could redeem only once, within 10 minutes, and only
 * until the operator does; the session token itself never appears on the hub machine.
 *
 * NOTHING SECRET ON DISK. Grant and session live in memory; the only writes are the
 * account row (enabled or not — state, not a secret) and the audit lines. A restart ends
 * everything by construction.
 *
 * AUDIT (`auth.break_glass.*`, `detail.grantRef` ties one grant's lines together): grant
 * (who, as the socket client reports its OS user), redeem (client address, T-22), every
 * request the session makes (`use`, rest-auth.ts), end (why). Plus the account's own
 * `user.create`/`user.enable`/`user.disable` lines and the actions taken, attributed to
 * the break-glass account.
 *
 * Only on a hub that requires login: elsewhere {@link BreakGlass.enabled} is false, the
 * socket is never started and the route is never dispatched (server.ts).
 *
 * @module hub/break-glass
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  BREAK_GLASS_EMAIL,
  closeBreakGlassAccounts,
  findHubAccount,
  type HubAuth,
  openBreakGlassAccount
} from '@slayzone/hub-auth/server'
import { clientAddress } from '@slayzone/platform/client-address'
import { routeOf, securityEvent } from '@slayzone/platform/security-log'
import type { RestPrincipal } from '@slayzone/transport/server'

/** Where a grant is redeemed (POST) and a session ends itself (DELETE). */
export const BREAK_GLASS_PATH = '/api/auth/break-glass'

/** A break-glass session token: `szbg_` + 32 random bytes, base64url. */
export const BREAK_GLASS_TOKEN_PREFIX = 'szbg_'

/** How long a grant waits to be redeemed. */
export const BREAK_GLASS_GRANT_TTL_MS = 10 * 60_000

/** Session lifetime when `--ttl` is not given, and its bounds. */
export const BREAK_GLASS_DEFAULT_TTL_MS = 30 * 60_000
export const BREAK_GLASS_MIN_TTL_MS = 60_000
export const BREAK_GLASS_MAX_TTL_MS = 2 * 60 * 60_000

/** Break-glass v1's credentials file — never read, only removed. */
const LEGACY_FILE = 'hub.break-glass.json'

/** base64url SHA-256: exactly 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/
/** base64url, at least 32 bytes' worth (PKCE's range). */
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/

const MAX_BODY_BYTES = 4096

/** The challenge a verifier answers: base64url SHA-256. */
export function breakGlassChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url')
}

/** Prefix check only, so a caller can route without a lookup (like `isWebSessionToken`). */
export function isBreakGlassToken(value: string): boolean {
  return (
    value.startsWith(BREAK_GLASS_TOKEN_PREFIX) && value.length > BREAK_GLASS_TOKEN_PREFIX.length
  )
}

/** Who opened or ended a grant, as the socket client reports its own OS identity. Node
 *  cannot read a unix socket peer's credentials, so this is a record, not a check —
 *  Azure's activity log names who ran Run Command. */
export interface BreakGlassOperator {
  osUser: string | null
  uid: number | null
  sudoUser: string | null
}

export type BreakGlassEndReason = 'expired' | 'ended' | 'ended_by_session' | 'stop'

export type BreakGlassStatus =
  | { state: 'idle' }
  | { state: 'pending'; ref: string; grantExpiresAt: number; ttlMs: number }
  | { state: 'active'; ref: string; redeemedAt: number; expiresAt: number }

export type BreakGlassGrantResult =
  | { ok: true; ref: string; grantExpiresAt: number; ttlMs: number; replaced: boolean }
  | { ok: false; code: 'unavailable' | 'invalid' | 'session_open'; error: string }

export type BreakGlassRedeemRefusal =
  | 'unavailable'
  | 'invalid'
  | 'none'
  | 'expired'
  | 'used'
  | 'mismatch'
  | 'failed'

export type BreakGlassRedeemResult =
  | { ok: true; token: string; expiresAt: number; userId: string; email: string }
  | { ok: false; reason: BreakGlassRedeemRefusal }

export interface BreakGlass {
  /** A hub that requires login, with hub-auth up. */
  enabled(): boolean
  grant(input: {
    challenge: unknown
    ttlMs?: unknown
    by: BreakGlassOperator
  }): Promise<BreakGlassGrantResult>
  redeem(input: { verifier: unknown; ip: string | null }): Promise<BreakGlassRedeemResult>
  end(
    reason: BreakGlassEndReason,
    by?: BreakGlassOperator | null
  ): Promise<{ grant: boolean; session: boolean }>
  status(): BreakGlassStatus
  /** The open session's principal for `token` — admin, `full` — or null. */
  resolve(token: string): Promise<RestPrincipal | null>
  /** Whether `token` is the open session's (no account check). */
  isSessionToken(token: string): boolean
  /** Boot: remove v1's file and close every break-glass account an earlier run left. */
  closeAtBoot(dataRoot: string): Promise<string[]>
}

/** A cancellable one-shot timer (a test seam: the default is an unref'd setTimeout). */
export type BreakGlassScheduler = (fn: () => void, ms: number) => { cancel(): void }

const defaultScheduler: BreakGlassScheduler = (fn, ms) => {
  const timer = setTimeout(fn, Math.max(0, ms))
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

interface Pending {
  ref: string
  challenge: string
  expiresAt: number
  ttlMs: number
}

interface Active {
  ref: string
  challenge: string
  tokenHash: Buffer
  userId: string
  redeemedAt: number
  expiresAt: number
  timer: { cancel(): void }
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

/** Constant-time equality of two strings (any lengths). */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

const iso = (ms: number): string => new Date(ms).toISOString()

const operatorDetail = (by: BreakGlassOperator | null | undefined): Record<string, unknown> =>
  by ? { osUser: by.osUser, uid: by.uid, sudoUser: by.sudoUser } : {}

export function createBreakGlass(deps: {
  getAuth: () => HubAuth | null
  /** `SLAYZONE_HUB_REQUIRE_LOGIN`. */
  requireLogin: boolean
  /** What closing revokes outside hub-auth (user-access.ts `revokeUser`, T-12). */
  revokeUser: (userId: string) => Promise<unknown>
  now?: () => number
  schedule?: BreakGlassScheduler
  log?: (message: string) => void
}): BreakGlass {
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? defaultScheduler
  const log = deps.log ?? ((m: string) => console.log(m))
  let pending: Pending | null = null
  let active: Active | null = null

  // Every state change runs one at a time, in order: a grant is consumed exactly once
  // however many redemptions race, and an end can never interleave with a redeem.
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }

  const enabled = (): boolean => deps.requireLogin && deps.getAuth() !== null

  const auditEnd = (
    stage: 'grant' | 'session' | 'boot',
    reason: string,
    extra: Record<string, unknown>,
    targetId: string | null = null
  ): void =>
    securityEvent({
      event: 'auth.break_glass.end',
      outcome: 'success',
      actor: null,
      ip: null,
      route: null,
      targetKind: targetId ? 'user' : null,
      targetId,
      detail: { stage, reason, ...extra }
    })

  /** Forget the session (the resolver refuses it from this line on), then close the
   *  account. Inside `serialize` only. */
  const closeSession = async (
    reason: BreakGlassEndReason,
    by: BreakGlassOperator | null
  ): Promise<boolean> => {
    const session = active
    if (!session) return false
    active = null
    session.timer.cancel()
    const auth = deps.getAuth()
    if (auth) await closeBreakGlassAccounts(auth, { revokeExternalSessions: deps.revokeUser })
    auditEnd(
      'session',
      reason,
      {
        grantRef: session.ref,
        durationSec: Math.round((now() - session.redeemedAt) / 1000),
        ...operatorDetail(by)
      },
      session.userId
    )
    log(`[slayzone] break-glass session ${session.ref} ended (${reason})`)
    return true
  }

  const expireTimer = (session: Active): void => {
    void serialize(async () => (active === session ? closeSession('expired', null) : false)).catch(
      (err: unknown) =>
        log(
          `[slayzone] break-glass: closing the expired session failed (the next boot closes ` +
            `the account): ${err instanceof Error ? err.message : String(err)}`
        )
    )
  }

  return {
    enabled,

    grant: (input) =>
      serialize(async (): Promise<BreakGlassGrantResult> => {
        if (!enabled()) {
          return {
            ok: false,
            code: 'unavailable',
            error: 'break-glass is only for a hub that requires login'
          }
        }
        if (typeof input.challenge !== 'string' || !CHALLENGE.test(input.challenge)) {
          return {
            ok: false,
            code: 'invalid',
            error:
              'the challenge must be the 43-character code `slay hub break-glass start` printed'
          }
        }
        const ttlMs = input.ttlMs ?? BREAK_GLASS_DEFAULT_TTL_MS
        if (
          typeof ttlMs !== 'number' ||
          !Number.isInteger(ttlMs) ||
          ttlMs < BREAK_GLASS_MIN_TTL_MS ||
          ttlMs > BREAK_GLASS_MAX_TTL_MS
        ) {
          return {
            ok: false,
            code: 'invalid',
            error: `the session lifetime must be between ${BREAK_GLASS_MIN_TTL_MS / 60_000} and ${BREAK_GLASS_MAX_TTL_MS / 60_000} minutes`
          }
        }
        const t = now()
        if (active && active.expiresAt <= t) await closeSession('expired', null)
        if (active) {
          securityEvent({
            event: 'auth.break_glass.grant',
            outcome: 'denied',
            actor: null,
            ip: null,
            route: null,
            detail: { reason: 'session_open', grantRef: active.ref, ...operatorDetail(input.by) }
          })
          return {
            ok: false,
            code: 'session_open',
            error:
              `a break-glass session is open until ${iso(active.expiresAt)} — end it first ` +
              '(`slayzone-hub break-glass end`)'
          }
        }
        let replaced = false
        if (pending) {
          auditEnd('grant', pending.expiresAt <= t ? 'expired' : 'replaced', {
            grantRef: pending.ref
          })
          replaced = pending.expiresAt > t
        }
        const grant: Pending = {
          ref: randomBytes(6).toString('hex'),
          challenge: input.challenge,
          expiresAt: t + BREAK_GLASS_GRANT_TTL_MS,
          ttlMs
        }
        pending = grant
        securityEvent({
          event: 'auth.break_glass.grant',
          outcome: 'success',
          level: 'warn',
          actor: null,
          ip: null,
          route: null,
          detail: {
            grantRef: grant.ref,
            ttlSec: ttlMs / 1000,
            redeemBy: iso(grant.expiresAt),
            via: 'hub-admin-socket',
            ...operatorDetail(input.by)
          }
        })
        log(
          `[slayzone] break-glass grant ${grant.ref} opened by ${input.by.osUser ?? 'unknown'} ` +
            `(redeem by ${iso(grant.expiresAt)}; session ${ttlMs / 60_000} min)`
        )
        return { ok: true, ref: grant.ref, grantExpiresAt: grant.expiresAt, ttlMs, replaced }
      }),

    redeem: (input) =>
      serialize(async (): Promise<BreakGlassRedeemResult> => {
        const auth = deps.getAuth()
        if (!enabled() || !auth) return { ok: false, reason: 'unavailable' }
        const deny = (
          reason: Exclude<BreakGlassRedeemRefusal, 'unavailable' | 'failed'>,
          grantRef: string | null = null
        ): BreakGlassRedeemResult => {
          securityEvent({
            event: 'auth.break_glass.redeem',
            outcome: 'denied',
            actor: null,
            ip: input.ip,
            route: `POST ${BREAK_GLASS_PATH}`,
            detail: { reason, ...(grantRef ? { grantRef } : {}) }
          })
          return { ok: false, reason }
        }
        if (typeof input.verifier !== 'string' || !VERIFIER.test(input.verifier)) {
          return deny('invalid')
        }
        const challenge = breakGlassChallenge(input.verifier)
        if (active && sameSecret(active.challenge, challenge)) return deny('used', active.ref)
        const grant = pending
        if (!grant) return deny('none')
        const t = now()
        if (grant.expiresAt <= t) {
          pending = null
          auditEnd('grant', 'expired', { grantRef: grant.ref })
          return deny('expired', grant.ref)
        }
        // A wrong verifier leaves the grant in place: guessing cannot burn the operator's.
        if (!sameSecret(grant.challenge, challenge)) return deny('mismatch', grant.ref)
        // Consumed before the first await: once, whatever happens next.
        pending = null
        let userId: string
        try {
          userId = (await openBreakGlassAccount(auth)).userId
        } catch (err) {
          securityEvent({
            event: 'auth.break_glass.redeem',
            outcome: 'failure',
            actor: null,
            ip: input.ip,
            route: `POST ${BREAK_GLASS_PATH}`,
            detail: { reason: 'account', grantRef: grant.ref }
          })
          log(
            `[slayzone] break-glass: could not open the account: ${err instanceof Error ? err.message : String(err)}`
          )
          return { ok: false, reason: 'failed' }
        }
        const token = `${BREAK_GLASS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
        const redeemedAt = now()
        const expiresAt = redeemedAt + grant.ttlMs
        const session: Active = {
          ref: grant.ref,
          challenge: grant.challenge,
          tokenHash: sha256(token),
          userId,
          redeemedAt,
          expiresAt,
          timer: { cancel: () => undefined }
        }
        session.timer = schedule(() => expireTimer(session), grant.ttlMs)
        active = session
        securityEvent({
          event: 'auth.break_glass.redeem',
          outcome: 'success',
          level: 'warn',
          actor: userId,
          ip: input.ip,
          route: `POST ${BREAK_GLASS_PATH}`,
          targetKind: 'user',
          targetId: userId,
          detail: { grantRef: grant.ref, ttlSec: grant.ttlMs / 1000, expiresAt: iso(expiresAt) }
        })
        log(
          `[slayzone] break-glass session ${grant.ref} open until ${iso(expiresAt)} ` +
            `(redeemed from ${input.ip ?? 'unknown'})`
        )
        return { ok: true, token, expiresAt, userId, email: BREAK_GLASS_EMAIL }
      }),

    end: (reason, by = null) =>
      serialize(async () => {
        let grant = false
        if (pending) {
          auditEnd('grant', reason, { grantRef: pending.ref, ...operatorDetail(by) })
          pending = null
          grant = true
        }
        const session = await closeSession(reason, by)
        return { grant, session }
      }),

    status: () => {
      const t = now()
      if (active && active.expiresAt > t) {
        return {
          state: 'active',
          ref: active.ref,
          redeemedAt: active.redeemedAt,
          expiresAt: active.expiresAt
        }
      }
      if (pending && pending.expiresAt > t) {
        return {
          state: 'pending',
          ref: pending.ref,
          grantExpiresAt: pending.expiresAt,
          ttlMs: pending.ttlMs
        }
      }
      return { state: 'idle' }
    },

    isSessionToken: (token) =>
      active !== null &&
      isBreakGlassToken(token) &&
      timingSafeEqual(sha256(token), active.tokenHash),

    resolve: async (token) => {
      const session = active
      if (!session || !isBreakGlassToken(token)) return null
      if (!timingSafeEqual(sha256(token), session.tokenHash)) return null
      // The timer ends it on time; this refuses it even if the timer has not run yet.
      if (now() >= session.expiresAt) {
        expireTimer(session)
        return null
      }
      const auth = deps.getAuth()
      if (!auth) return null
      // Second line: the account must still be the open, admin break-glass account.
      const account = await findHubAccount(auth, session.userId)
      if (!account || account.disabled || account.role !== 'admin') return null
      return { userId: session.userId, role: 'admin', scopes: ['full'] }
    },

    closeAtBoot: (dataRoot) =>
      serialize(async () => {
        const auth = deps.getAuth()
        if (!auth) return []
        const file = join(dataRoot, LEGACY_FILE)
        const legacyFile = await stat(file).then(
          () => true,
          (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return false
            throw err
          }
        )
        if (legacyFile) await rm(file, { force: true })
        const closed = await closeBreakGlassAccounts(auth, {
          revokeExternalSessions: deps.revokeUser
        })
        if (closed.length > 0 || legacyFile) {
          auditEnd('boot', 'boot', { accounts: closed.length, legacyFile })
          log(
            `[slayzone] break-glass: closed ${closed.length} account(s) an earlier run left open` +
              (legacyFile ? `; removed the v1 file ${file}` : '')
          )
        }
        return closed
      })
  }
}

/** Read a small JSON body; null when it is not one. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** The one answer to every refused redemption: which check failed is in the audit line,
 *  not in a reply anyone on the internet can read. */
const REFUSED = {
  ok: false,
  code: 'BREAK_GLASS_REFUSED',
  error:
    'no break-glass grant matches — open one on the hub machine (`slayzone-hub break-glass ' +
    'open`) and redeem it within 10 minutes, once'
} as const

/**
 * `/api/auth/break-glass` (server.ts dispatches it only while {@link BreakGlass.enabled}):
 *   POST `{ verifier }` → 200 `{ ok, token, expiresAt, email }`, or 403
 *        `BREAK_GLASS_REFUSED` (no grant, expired, used, wrong verifier — one reply).
 *        Gate-exempt like sign-in (rest-auth.ts): it is how a credential is obtained.
 *   DELETE with the session as bearer → ends it (200), else 401.
 */
export function handleBreakGlassRequest(
  breakGlass: BreakGlass,
  req: IncomingMessage,
  res: ServerResponse
): void {
  const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    if (res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const fail = (err: unknown): void => {
    send(500, { ok: false, error: 'break-glass failed' })
    process.stderr.write(
      `[slayzone] break-glass request failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }
  if (req.method === 'POST') {
    void readJsonBody(req)
      .then(async (body) => {
        if (!body) {
          send(400, { ok: false, error: 'expected a JSON body { "verifier": "…" }' })
          return
        }
        const result = await breakGlass.redeem({
          verifier: body.verifier,
          ip: clientAddress(req)
        })
        if (result.ok) {
          send(200, {
            ok: true,
            token: result.token,
            expiresAt: iso(result.expiresAt),
            email: result.email
          })
          return
        }
        switch (result.reason) {
          case 'unavailable':
            send(404, { ok: false, error: 'Not found' })
            return
          case 'invalid':
            send(400, { ok: false, error: 'the verifier is malformed' })
            return
          case 'failed':
            send(500, {
              ok: false,
              error: 'break-glass could not open its account — see the hub log'
            })
            return
          default:
            send(403, REFUSED)
        }
      })
      .catch(fail)
    return
  }
  if (req.method === 'DELETE') {
    const match = /^Bearer[ ]+(.+)$/i.exec(
      typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : ''
    )
    const token = match?.[1]?.trim() ?? ''
    if (!token || !breakGlass.isSessionToken(token)) {
      securityEvent({
        event: 'authz.denied',
        outcome: 'denied',
        actor: null,
        ip: clientAddress(req),
        route: routeOf(req.method, req.url),
        detail: { reason: 'break_glass_end', status: 401 }
      })
      send(401, { ok: false, error: 'Unauthorized' })
      return
    }
    void breakGlass
      .end('ended_by_session')
      .then(() => send(200, { ok: true }))
      .catch(fail)
    return
  }
  send(405, { ok: false, error: 'Method not allowed' }, { allow: 'POST, DELETE' })
}
