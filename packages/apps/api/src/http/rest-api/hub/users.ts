import type { IncomingHttpHeaders } from 'node:http'
import type { Express } from 'express'
import { isLoopbackPeer } from '@slayzone/platform'
import { runAsSecurityActor } from '@slayzone/platform/security-log'
import { auditRouteRefusal } from '../route-audit'
import { ADMIN_ONLY } from '../../../admin-policy'
import type { PrincipalRole } from '@slayzone/trpc-server'
import type { RestApiDeps } from '../types'
import { respondSwitchRefusal } from '../switch-refusal'

/**
 * REST: `/api/hub/users` — operator account management, backing
 * `slay hub users add|ls|disable|enable|role`. Accounts are disabled, never deleted
 * (hub-auth users.ts).
 *
 * WHY THIS EXISTS: a hub that enforces auth gates its whole surface on a
 * better-auth bearer, and public signup is CLOSED (`emailAndPassword.disableSignUp`
 * in hub-auth's auth.ts) because `/api/auth/sign-up/email` must stay gate-exempt
 * for a token-less client to reach — which had made any reachable hub
 * self-registerable. So administering accounts needs a channel that does not
 * itself depend on the outer gate.
 *
 * WAS LOOPBACK-ONLY, NOW A BEARER FROM EVERYONE ONCE AUTH IS REQUIRED. Every
 * non-supervised hub enforces auth (`server.ts`: `hubAuthRequired = !supervised`),
 * which made the old rule — any loopback peer administers accounts, bearer never
 * consulted — the exact fail-open a reverse proxy turns into "anyone reaches this
 * route": every request through a co-located proxy arrives with a loopback
 * `remoteAddress`. Loopback stays the ONLY authority on a hub with no auth at all
 * (supervised — there are no sessions to check), because that is the one shape
 * where "on the box" genuinely is the whole story. See {@link hubUsersAuthDecision}
 * for the exact matrix — it mirrors {@link joinTokenAuthDecision}'s, by design:
 * the same reverse-proxy shape threatened both routes, and diverging their rules
 * would leave one silently unrepaired.
 *
 * WHY A LOOPBACK CALLER CAN STILL GET A BEARER, on a hub that now requires one:
 * `ensureBootstrapOwner` (bootstrap-owner.ts) provisions a real first-user session
 * on first boot specifically so a co-located caller is never locked out, and
 * `hub.owner.json` carries it. The CLI reads that file automatically when nothing
 * else is configured (api.ts, hub-request.ts) — so `slay hub users add` on the hub
 * box keeps working with no operator action, it just now carries a real
 * credential instead of relying on the peer address.
 *
 * ADMIN ONLY once auth is required: the bearer must be a `full` session whose
 * account is `role: 'admin'`. Any signed-in account could otherwise add accounts,
 * disable others, or make itself admin. A `user` gets 403 (`not_admin`). The
 * bootstrap owner is created admin, so the owner file keeps working on the box.
 *
 * ON A HUB WITH ENTRA SIGN-IN the role is the Entra app role (hub-auth entra.ts): a
 * role change, or `add` asking for an admin, answers 409 with the stable code
 * {@link SSO_MANAGED_ROLE_CODE}. Disable / enable are unchanged.
 *
 * WITH PASSWORD SIGN-IN OFF (`SLAYZONE_HUB_ENABLE_PASSWORD=0`, T-10) `add` answers 403
 * `HUB_PASSWORD_DISABLED`: every account it makes is a password account
 * (hub-auth `createHubUser` refuses and writes the audit line). The rest is unchanged.
 *
 * ONE PATH, ONE ENTRY IN THE GATE. The bearer gate's `SELF_GUARDED` set
 * (`apps/hub/src/rest-auth.ts`) matches the pathname EXACTLY, so a
 * `PATCH /api/hub/users/:email` shape could not be exempted without teaching the
 * gate prefix matching — which would weaken it for every route. Every method
 * therefore carries the email in the request body (same shape as
 * `DELETE /api/tasks/:id/tags`): GET lists, POST creates, PATCH disables, enables or
 * changes the role. DELETE is gone (accounts are never deleted) and answers 410
 * naming `disable`, so an older `slay hub users rm` gets a reason, not a 404.
 *
 * Gating mirrors the join-token route: the capability slot (`deps.hubUsers`) is
 * wired only by the hub composition root, and hub-auth is built ASYNC, so
 *   - slot absent (Electron host, or a build without hub-auth) → 503
 *   - slot present but `ready()` false (init pending, or createHubAuth threw) → 503
 *   - otherwise → the operation runs
 *
 * @module transport/rest-api/hub/users
 */

/**
 * True for IPv4/IPv6 loopback, incl. the IPv4-mapped-IPv6 form node reports.
 *
 * Exported so the 403 decision is directly unit-testable: `mountRestApp` always
 * binds 127.0.0.1, so a test driving the route over HTTP can never produce a
 * non-loopback peer. The implementation is the single shared one in
 * `@slayzone/platform` — this file, the join-token route and the hub's
 * `rest-auth` each used to carry their own copy of the same predicate.
 */
export const isLoopbackAddress = isLoopbackPeer

/** What to do with a `/api/hub/users` request, once its peer + credential are
 *  known. The three outcomes of {@link joinTokenAuthDecision} — see its
 *  docstring for the shared reasoning; this is repeated rather than imported
 *  because the two routes live in sibling directories with no shared parent
 *  that isn't `RestApiDeps` itself — plus `not-admin`. */
export type HubUsersAuthOutcome = 'allow' | 'forbid' | 'unauthorized' | 'not-admin'

/**
 * Decide whether a caller may administer hub accounts. Pure, so the off-box and
 * proxied-loopback rows are testable without a real socket.
 *
 * - auth NOT required (supervised — no sessions exist) → loopback is the sole
 *   authority, exactly as before. Off-box gets nothing to authenticate with.
 * - auth required (every standalone hub) → a bearer is required from EVERYONE,
 *   loopback included. `bearerOk` is never skipped for a loopback peer here —
 *   that unconditional skip was the bug: a reverse proxy in front of a standalone
 *   hub makes every request loopback, so it was the same as no gate at all.
 * - 401 (not 403) on a missing bearer when auth IS required: the caller has a
 *   credential problem (sign in / read the owner file), not a policy one.
 * - a valid full bearer whose account is not admin → `not-admin` (403): the
 *   credential is fine, the account may not do this.
 */
export function hubUsersAuthDecision(opts: {
  loopback: boolean
  authRequired: boolean
  /** A verified `full`-scope session. */
  bearerOk: boolean
  /** That session's account has `role: 'admin'`. */
  admin: boolean
}): HubUsersAuthOutcome {
  if (!opts.authRequired) return opts.loopback ? 'allow' : 'forbid'
  if (!opts.bearerOk) return 'unauthorized'
  return opts.admin ? 'allow' : 'not-admin'
}

/** The internal identity that owns computer API keys — never operator-creatable. */
const COMPUTER_SERVICE_USER_EMAIL = 'computers@slayzone.internal'

/**
 * Stable code of a role change (or an admin `add`) refused because the hub has Entra
 * sign-in: there the role is the Entra app role, written at every sign-in (O-4).
 */
export const SSO_MANAGED_ROLE_CODE = 'SSO_MANAGED_ROLE'

const SSO_MANAGED_ROLE = {
  ok: false,
  code: SSO_MANAGED_ROLE_CODE,
  error:
    'roles on this hub come from Entra ID: assign or remove the SlayZone.Admin app role ' +
    'on the enterprise application — it applies at the account’s next sign-in'
} as const

const ROLES: readonly PrincipalRole[] = ['admin', 'user']
const isRole = (value: unknown): value is PrincipalRole =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value)

/** Cheap shape check. Real validation is the hub operator's judgement; this only
 *  rejects input that could not possibly be an address. */
function isPlausibleEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 2 && trimmed.includes('@') && !/\s/.test(trimmed)
}

export function registerHubUsersRoutes(app: Express, deps: RestApiDeps): void {
  /**
   * Resolve the capability, or write the terminal response and return null.
   * Every method needs the identical four-step preamble (peer/bearer decision
   * first, then the same capability checks as before).
   */
  const gate = async (
    req: { socket: { remoteAddress?: string | undefined }; headers: IncomingHttpHeaders },
    res: {
      status: (code: number) => { json: (body: unknown) => void }
    }
  ): Promise<NonNullable<RestApiDeps['hubUsers']> | null> => {
    const loopback = isLoopbackAddress(req.socket.remoteAddress ?? undefined)
    const authRequired = deps.restAuth?.required() === true
    // Only verify when the answer can matter — mirrors join-token.ts. An absent
    // `restAuth` slot (the Electron host) means no bearer authority at all, which
    // collapses `authRequired` to false and this whole check to loopback-only.
    //
    // FULL AND ADMIN: administering accounts is not a classified tRPC scope, so a
    // scoped web session must never satisfy this regardless of what its bearer
    // or cookie would otherwise resolve to; and only an admin account may.
    const principal = authRequired ? await deps.restAuth!.verifyBearer(req.headers, {}) : null
    const bearerOk = principal?.scopes.includes('full') === true
    const admin = principal?.role === 'admin'
    const decision = hubUsersAuthDecision({ loopback, authRequired, bearerOk, admin })
    if (decision !== 'allow') auditRouteRefusal(req, decision, principal)
    if (decision === 'forbid') {
      res.status(403).json({ ok: false, error: 'hub user management is loopback-only' })
      return null
    }
    if (decision === 'not-admin') {
      res.status(403).json({
        ok: false,
        error:
          'hub user management needs an admin account — an admin can grant it with ' +
          '`slay hub users role <email> admin`',
        code: ADMIN_ONLY
      })
      return null
    }
    if (decision === 'unauthorized') {
      res.status(401).json({
        ok: false,
        error: 'Unauthorized — sign in with `slay hub login <url>`, or run this on the hub box'
      })
      return null
    }
    const users = deps.hubUsers
    if (!users) {
      res
        .status(503)
        .json({ ok: false, error: 'hub user management is not available on this host' })
      return null
    }
    if (!users.ready()) {
      // Not merely a startup race: hubAuthRef stays null forever if createHubAuth
      // threw (the composition root swallows that into a diagnostic), so name where
      // to look rather than implying the caller should just retry.
      res.status(503).json({
        ok: false,
        error: 'hub-auth unavailable — check the hub log for `computer.init_failed`'
      })
      return null
    }
    // The account commands run as the verified caller, so their audit lines name them.
    const actor = principal?.userId ?? null
    return {
      ...users,
      create: (input) => runAsSecurityActor(actor, () => users.create(input)),
      disable: (email) => runAsSecurityActor(actor, () => users.disable(email)),
      enable: (email) => runAsSecurityActor(actor, () => users.enable(email)),
      setRole: (email, role) => runAsSecurityActor(actor, () => users.setRole(email, role))
    }
  }

  // Create an account. Returns the generated password ONCE — it is not recoverable.
  app.post('/api/hub/users', async (req, res) => {
    const users = await gate(req, res)
    if (!users) return
    const body = (req.body ?? {}) as { email?: unknown; name?: unknown; role?: unknown }
    if (!isPlausibleEmail(body.email)) {
      res.status(400).json({ ok: false, error: 'email required' })
      return
    }
    if (body.role !== undefined && !isRole(body.role)) {
      res.status(400).json({ ok: false, error: 'role must be admin or user' })
      return
    }
    const role = body.role
    const email = body.email.trim()
    if (email.toLowerCase() === COMPUTER_SERVICE_USER_EMAIL) {
      res.status(400).json({
        ok: false,
        error: `${COMPUTER_SERVICE_USER_EMAIL} is reserved for the internal computer service identity`
      })
      return
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined
    try {
      const result = await users.create({
        email,
        ...(name === undefined ? {} : { name }),
        ...(role === undefined ? {} : { role })
      })
      if (!result.ok) {
        res
          .status(409)
          .json(
            result.reason === 'sso-managed'
              ? SSO_MANAGED_ROLE
              : { ok: false, error: 'a user with that email already exists' }
          )
        return
      }
      res.json({ ok: true, data: result.user })
    } catch (err) {
      if (respondSwitchRefusal(res, err)) return
      res.status(500).json({
        ok: false,
        error: 'failed to create user',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })

  // List accounts. Excludes the computer service identity (see users.ts).
  app.get('/api/hub/users', async (req, res) => {
    const users = await gate(req, res)
    if (!users) return
    try {
      res.json({ ok: true, data: await users.list() })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'failed to list users',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })

  // Disable, enable, or change the role of an account. Email in the BODY, not the
  // path — see the module note. Exactly one change per request.
  app.patch('/api/hub/users', async (req, res) => {
    const users = await gate(req, res)
    if (!users) return
    const body = (req.body ?? {}) as { email?: unknown; disabled?: unknown; role?: unknown }
    if (!isPlausibleEmail(body.email)) {
      res.status(400).json({ ok: false, error: 'email required' })
      return
    }
    const email = body.email.trim()
    const change =
      typeof body.disabled === 'boolean' && body.role === undefined
        ? ({ disabled: body.disabled } as const)
        : body.disabled === undefined && isRole(body.role)
          ? ({ role: body.role } as const)
          : null
    if (!change) {
      res.status(400).json({
        ok: false,
        error: 'send exactly one of disabled (true|false) or role (admin|user)'
      })
      return
    }
    try {
      const outcome =
        change.role !== undefined
          ? await users.setRole(email, change.role)
          : change.disabled
            ? await users.disable(email)
            : await users.enable(email)
      switch (outcome) {
        case 'ok':
          res.json({ ok: true, data: { email, ...change } })
          return
        case 'not-found':
          res.status(404).json({ ok: false, error: `no user with email ${email}` })
          return
        case 'protected':
          res.status(409).json({
            ok: false,
            error:
              email.toLowerCase() === COMPUTER_SERVICE_USER_EMAIL
                ? `${COMPUTER_SERVICE_USER_EMAIL} is the internal computer service identity, not an account`
                : // The other protected kind: a break-glass account (hub-auth break-glass.ts).
                  `${email} is the break-glass account — only \`slayzone-hub break-glass\` on the ` +
                  'hub machine opens or ends it'
          })
          return
        case 'last-user':
          res.status(409).json({
            ok: false,
            error:
              'refusing to disable the last enabled account — public signup is disabled, ' +
              'so no one could sign in to the hub again'
          })
          return
        case 'last-admin':
          res.status(409).json({
            ok: false,
            error:
              `refusing to ${change.role !== undefined ? 'demote' : 'disable'} the last enabled admin — ` +
              'make another account admin first (`slay hub users role <email> admin`)'
          })
          return
        case 'sso-managed':
          res.status(409).json(SSO_MANAGED_ROLE)
          return
      }
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'failed to update user',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })

  // Accounts are never deleted. Gated like the rest, so it tells nothing to a caller
  // who could not have used it.
  app.delete('/api/hub/users', async (req, res) => {
    const users = await gate(req, res)
    if (!users) return
    res.status(410).json({
      ok: false,
      error:
        'accounts are no longer removed: `slay hub users rm` was renamed to ' +
        '`slay hub users disable <email>` (the account and its data are kept)'
    })
  })
}
