import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import {
  securityEvent,
  type SecurityEventName,
  type SecurityOutcome
} from '@slayzone/platform/security-log'
import { TRPCError } from '@trpc/server'
import {
  router,
  publicProcedure,
  getAuthGate,
  adminOnlyTrpcError,
  callerIsNotAdmin,
  type TrpcContext
} from '@slayzone/trpc-server'
import { getComputersDeps, getComputersDepsOrNull } from './computers-deps'
import {
  getComputersRouterDeps,
  notifyComputerBindingChanged,
  type ComputerManagerAccess
} from './computers-router-deps'
import { decideJoinTokenMint, isJoinTokenForbidden } from './join-token-policy'
import {
  getComputerUpgradeStatuses,
  listComputers as storeListComputers,
  revokeComputer as storeRevokeComputer,
  unrevokeComputer as storeUnrevokeComputer,
  deleteComputer as storeDeleteComputer,
  setProjectDefaultComputer as storeSetProjectDefaultComputer,
  setTaskComputer as storeSetTaskComputer,
  resolveTaskComputerId as storeResolveTaskComputerId,
  getComputer as storeGetComputer,
  setComputerDisabled as storeSetComputerDisabled,
  renameComputer as storeRenameComputer
} from './store'
import {
  computerDisabledError,
  computerHasRunningWorkError,
  computerIsLocalError,
  computerNameReservedError,
  type ComputerStateError
} from './computer-state-errors'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '../shared/types'
import { mintJoinToken as storeMintJoinToken } from './join-tokens'
import {
  machinesByHostId as storeMachinesByHostId,
  renameMachine as storeRenameMachine
} from './machines'
import {
  ownsEveryComputerOnHost,
  claimComputer as storeClaimComputer,
  setComputerVisibility as storeSetComputerVisibility
} from './visibility'

/**
 * Audit line for a change to who can use a computer (T-03). The acting user, peer
 * address and procedure come from the request context `publicProcedure` sets.
 */
function auditComputer(
  event: SecurityEventName,
  computerId: string,
  outcome: SecurityOutcome = 'success',
  detail?: Record<string, unknown>
): void {
  securityEvent({ event, outcome, targetKind: 'computer', targetId: computerId, detail })
}

/**
 * Computers router — the tRPC surface over the hub/computer-split computer (hub side).
 *
 * Two dependency classes, deliberately separated so the router keeps working
 * before the async computer init resolves:
 *
 *  - Pure computer-binding CRUD (`list` store rows, `setTaskComputer`,
 *    `setProjectDefaultComputer`, `revokeComputer`) goes straight through `ctx.db`
 *    against the v149 computer tables. These never need the live gateway, so they
 *    work regardless of computer-init timing.
 *  - Live-computer operations (`list` connection-status merge, `mintJoinToken`)
 *    read the injected `ComputersDeps` (the gateway + hub URL).
 *    `list` degrades gracefully when the gateway isn't wired (store rows with a
 *    `connected: false` status); `mintJoinToken` REQUIRES it and throws a clear
 *    error before the listener has bound — minting a token for a hub that isn't
 *    listening would hand a computer an un-dialable URL.
 *
 * Follows the `processesRouter` conventions: `ctx.db`, `publicProcedure`, zod
 * inputs. `@slayzone/api` mounts it at `computers`.
 */

/**
 * The request as a computer MANAGER (T-19, api's `computer-access.ts` through the
 * router seam): the owner, or an admin, who sees every computer for management only.
 * Binding work to a computer is not management: `setTaskComputer` /
 * `setProjectDefaultComputer` are id-checked by the owner gate (`computer` in
 * owner-policy.ts — the owner only), so the admin role opens no path to run on, or
 * read from, another user's computer.
 */
const managerAccessOf = (
  ctx: Pick<TrpcContext, 'db' | 'principal' | 'dataRoot'>
): ComputerManagerAccess => getComputersRouterDeps().managerAccessFor(ctx)

const noSuchComputer = (): Error => new Error('no such computer, or you do not have access to it')

/** A computer-state refusal as tRPC carries it (`data.appCode` = its code). */
const stateRefusal = (
  code: 'BAD_REQUEST' | 'PRECONDITION_FAILED',
  cause: ComputerStateError
): TRPCError => new TRPCError({ code, message: cause.message, cause })

/** Refuse binding work to a computer that is missing or disabled. */
async function requireBindable(
  ctx: Pick<TrpcContext, 'db'>,
  computerId: string | null
): Promise<void> {
  if (computerId === null) return
  const row = await storeGetComputer(ctx.db, computerId)
  if (!row) throw noSuchComputer()
  if (row.disabled_at != null) {
    throw stateRefusal('PRECONDITION_FAILED', computerDisabledError(row.name))
  }
}

/** The desktop app's own computer on its own hub, which is never disabled or deleted. */
const isProtectedLocal = (computerId: string): boolean =>
  (getComputersDepsOrNull()?.localComputerId ?? null) === computerId

/**
 * Lifecycle of someone else's computer, or an unowned one, is the admin's (T-15,
 * `CONDITIONAL_ADMIN`): a user may revoke, delete or re-scope only their own. The
 * same message for a missing id as for one that is not the caller's.
 */
async function requireManager(
  ctx: Pick<TrpcContext, 'db' | 'principal' | 'dataRoot'>,
  path: string,
  computerId: string
): Promise<void> {
  if (!(await managerAccessOf(ctx).mayManage(computerId))) {
    // An admin manages every computer there is, so for one it is simply missing.
    throw callerIsNotAdmin(ctx) ? adminOnlyTrpcError(path) : noSuchComputer()
  }
  if (!(await storeGetComputer(ctx.db, computerId))) throw noSuchComputer()
}

export const computersRouter = router({
  /**
   * All non-revoked computers from the store, each annotated with live status from
   * the computer gateway (when wired). A computer in the store but not currently dialed
   * in reports `connected: false`.
   *
   * `connected` = socket open. `usable` = socket open AND heard from inside the
   * heartbeat window — that is the flag to gate work on. They differ while a computer
   * has gone silent but its watchdog has not reaped it yet, and `connected` alone
   * previously let a caller conclude a computer was available when it was not.
   */
  list: publicProcedure
    .input(z.object({ includeRevoked: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      // Revoked rows are RETURNED, not hidden: revoking is a deliberate act and the
      // row is how you undo it. The client dims and sorts them last.
      const rows = await storeListComputers(ctx.db, {
        includeRevoked: input?.includeRevoked ?? true
      })
      // The management view (T-19): the caller's own computers, or every one for an
      // admin — the same decision the lifecycle mutations below take, so the list
      // never shows a computer they would refuse or hides one they would accept.
      // Active rows only, as before T-19: the visibility predicate this replaces
      // never listed a revoked computer, whatever `includeRevoked` said.
      const visible = new Set(
        (await managerAccessOf(ctx).filterManaged(rows.filter((r) => r.revoked_at === null))).map(
          (r) => r.id
        )
      )
      // One query for the whole list rather than a join per row: the machine is
      // decoration, and a computer with no host id is legitimately ungrouped.
      const machines = await storeMachinesByHostId(ctx.db)
      const upgrades = await getComputerUpgradeStatuses(ctx.db)
      const deps = getComputersDepsOrNull()
      const gateway = deps?.getGateway()
      const live = gateway?.listComputers() ?? []
      const liveById = new Map(live.map((r) => [r.computerId, r]))
      const usableIds = new Set((gateway?.listUsableComputers() ?? []).map((r) => r.computerId))
      return rows
        .filter((row) => visible.has(row.id))
        .map((row) => {
          const conn = liveById.get(row.id)
          return {
            id: row.id,
            name: row.name,
            platform: row.platform,
            version: row.version,
            upgradeStatus: upgrades.get(row.id) as
              | (import('../shared/upgrade-status').ComputerUpgradeStatus & { reportedAt: number })
              | undefined,
            capabilities: parseCapabilities(row.capabilities_json),
            lastSeenAt: row.last_seen_at,
            createdAt: row.created_at,
            connected: conn !== undefined,
            usable: usableIds.has(row.id),
            connectedAt: conn?.connectedAt ?? null,
            revokedAt: row.revoked_at,
            // Enrolled and connected, but given no new work (`setDisabled`).
            disabledAt: row.disabled_at ?? null,
            // `hostId`, never a machine id: a merge destroys the losing row, so a
            // client holding one could act on an id that no longer exists. The host
            // id survives on the winner.
            machine: row.host_id
              ? (() => {
                  const m = machines.get(row.host_id)
                  return m ? { hostId: m.host_id, name: m.name } : null
                })()
              : null
          }
        })
    }),

  /**
   * Mint a single-use enrollment token. The token embeds the hub's computer WS URL
   * (sourced from the injected deps), so it can only be minted once the hub
   * listener has bound. It carries no certificate pin: the hub does not terminate
   * TLS, so a computer verifies the front end's certificate the normal way.
   *
   * `hubUrl` is returned alongside the token so a client can tell whether the
   * token is usable off-box (see `isLoopbackComputerUrl`) WITHOUT decoding it —
   * `decodeJoinToken` needs `Buffer`, which the renderer does not have. It is not
   * a secret: it is embedded in the token the caller already receives in full.
   * The REST twin has always returned it; this closes that shape gap.
   *
   * WHO IT IS FOR (T-20 + self-enroll, `join-token-policy.ts`): on a hub with login
   * every user mints for themselves (no `forUser`, or their own); only an admin may
   * name someone else — an account id or email of an enabled account, which owns the
   * computer that redeems the token. Without login, as before: no user, an unowned
   * computer. `ttlMs` at most 1 hour.
   */
  mintJoinToken: publicProcedure
    .input(
      z.object({
        label: z.string().min(1),
        ttlMs: z.number().int().positive().optional(),
        forUser: z.string().max(320).optional()
      })
    )
    .mutation(async ({ ctx, input }) => {
      const deps = getComputersDeps()
      const decision = await decideJoinTokenMint({
        loginRequired: getAuthGate(),
        forUser: input.forUser,
        ttlMs: input.ttlMs,
        caller: ctx.principal?.userId
          ? { userId: ctx.principal.userId, isAdmin: ctx.principal.role === 'admin' }
          : null,
        findAccount: deps.findAccount
      })
      if (!decision.ok) {
        throw new TRPCError({
          code: isJoinTokenForbidden(decision.error.code) ? 'FORBIDDEN' : 'BAD_REQUEST',
          message: decision.error.message,
          cause: decision.error
        })
      }
      const hubUrl = deps.getHubUrl()
      if (!hubUrl) {
        throw new Error('cannot mint join token — the computer listener has not bound its URL yet')
      }
      const minted = await storeMintJoinToken(ctx.db, {
        hubUrl,
        ttlMs: decision.ttlMs,
        label: input.label,
        mintedByUserId: ctx.principal?.userId ?? null,
        // The named user, or null on a hub without login (the normal local case),
        // which leaves the computer honestly unowned rather than attributed to a guess.
        ownerUserId: decision.ownerUserId
      })
      return {
        id: minted.id,
        token: minted.token,
        label: minted.label,
        createdAt: minted.created_at,
        expiresAt: minted.expires_at,
        hubUrl
      }
    }),

  /**
   * Pin a task to a computer (`null` = inherit the project default).
   *
   * Binding a task to a computer is code execution in that computer's $HOME. On a hub
   * with login the owner gate checks both ids before this runs (owner-policy.ts): the
   * task and the computer must both be the caller's, so the computer is the task
   * owner's. `null` (unbind) names no computer and can only narrow.
   */
  setTaskComputer: publicProcedure
    .input(z.object({ taskId: z.string(), computerId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await requireBindable(ctx, input.computerId)
      await storeSetTaskComputer(ctx.db, input.taskId, input.computerId)
      notifyComputerBindingChanged()
      return { ok: true as const }
    }),

  /** Set a project's default computer (`null` = no explicit default; exec falls back
   *  to the connected default computer). Checked like {@link setTaskComputer}. */
  setProjectDefaultComputer: publicProcedure
    .input(z.object({ projectId: z.string(), computerId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await requireBindable(ctx, input.computerId)
      await storeSetProjectDefaultComputer(ctx.db, input.projectId, input.computerId)
      notifyComputerBindingChanged()
      return { ok: true as const }
    }),

  /** Effective computer for a task (task binding → project default → null). */
  resolveTaskComputer: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(async ({ ctx, input }) => {
      const computerId = await storeResolveTaskComputerId(ctx.db, input.taskId)
      return { computerId }
    }),

  /**
   * Name a machine (`null` clears it).
   *
   * Keyed on HOST ID, never a machine id. Two rows can merge between a render and
   * a click, which deletes one of the ids the client was holding; the host id is
   * what survives on the winner.
   */
  renameMachine: publicProcedure
    .input(z.object({ hostId: z.string().min(1), name: z.string().trim().max(64).nullable() }))
    .mutation(async ({ ctx, input, path }) => {
      // A machine shared with anyone else, or unowned, is the admin's to name (T-15).
      if (callerIsNotAdmin(ctx)) {
        const userId = ctx.principal?.userId
        if (!userId || !(await ownsEveryComputerOnHost(ctx.db, input.hostId, userId))) {
          throw adminOnlyTrpcError(path)
        }
      }
      await storeRenameMachine(ctx.db, input.hostId, input.name)
      return { ok: true as const }
    }),

  /**
   * Take ownership of an UNOWNED computer. Never reassigns an owned one.
   *
   * REFUSED on a hub with login (T-19). There every computer gets its owner at enroll
   * — the user its join token was minted for — and an unowned one is visible to
   * admins only and serves nobody (`computer-access.ts`). Claiming would let whoever
   * asks first take a shell in an account that may not be theirs; the hub cannot
   * know whose machine it is. Re-enroll it with a token minted for its owner instead.
   */
  claim: publicProcedure
    .input(z.object({ computerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (getAuthGate()) {
        auditComputer('computer.claim', input.computerId, 'denied', { reason: 'login_hub' })
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'claiming a computer is off on a hub with login: re-enroll it with a join token ' +
            'minted for its owner'
        })
      }
      const userId = ctx.principal?.userId
      if (!userId) throw new Error('sign in to claim a computer')
      const claimed = await storeClaimComputer(ctx.db, input.computerId, userId)
      // Not claimed = it already has an owner, and claiming never reassigns one.
      auditComputer('computer.claim', input.computerId, claimed ? 'success' : 'denied')
      return { claimed }
    }),

  /**
   * Private, or visible to everyone on this hub. The owner or an admin.
   *
   * On a hub with login a computer is private, full stop (O-6, T-19): only `private`
   * is accepted there, because any other value would claim to open a machine that
   * the access rule (`canAccess`, owner only) keeps closed.
   */
  setVisibility: publicProcedure
    .input(z.object({ computerId: z.string(), visibility: z.enum(['private', 'hub', 'shared']) }))
    .mutation(async ({ ctx, input, path }) => {
      await requireManager(ctx, path, input.computerId)
      if (getAuthGate() && input.visibility !== 'private') {
        auditComputer('computer.visibility.set', input.computerId, 'denied', {
          visibility: input.visibility
        })
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'computers are private on a hub with login'
        })
      }
      await storeSetComputerVisibility(ctx.db, input.computerId, input.visibility)
      auditComputer('computer.visibility.set', input.computerId, 'success', {
        visibility: input.visibility
      })
      return { ok: true as const }
    }),

  /**
   * Clear a revocation. An admin's alone on a hub with login (T-19, `admin-policy.ts`):
   * it re-trusts a credential, and the revocation may have been the admin's response
   * to a lost machine or the side effect of disabling its owner (T-12) — neither is the
   * owner's to undo.
   *
   * Not enough on its own to bring the computer back: revoking made its next
   * `hello` fatal, so the process exited and its supervisor latched. Un-revoking
   * is half a RE-INVITE — the caller mints a fresh join token and hands it over.
   */
  unrevoke: publicProcedure
    .input(z.object({ computerId: z.string() }))
    .mutation(async ({ ctx, input, path }) => {
      await requireManager(ctx, path, input.computerId)
      await storeUnrevokeComputer(ctx.db, input.computerId)
      auditComputer('computer.unrevoke', input.computerId)
      return { ok: true as const }
    }),

  /**
   * Delete a computer and everything pointing at it.
   *
   * Bindings are NULLed rather than repointed — there is no survivor — and
   * placements and grants go with it. The columns carry no foreign keys, so
   * nothing does this for us and a dangling id resolves to a dead machine at
   * exec time.
   */
  delete: publicProcedure
    .input(z.object({ computerId: z.string() }))
    .mutation(async ({ ctx, input, path }) => {
      await requireManager(ctx, path, input.computerId)
      if (isProtectedLocal(input.computerId)) {
        throw stateRefusal('BAD_REQUEST', computerIsLocalError('deleted'))
      }
      await storeDeleteComputer(ctx.db, input.computerId)
      // Its open socket would otherwise keep it in the usable set until it re-dialed.
      getComputersDepsOrNull()?.getGateway()?.disconnect?.(input.computerId, 'computer deleted')
      auditComputer('computer.delete', input.computerId)
      // It never reconnects: whatever waited for it (a process run it kept) lets go.
      getComputersDepsOrNull()?.onComputerRemoved?.(input.computerId)
      return { ok: true as const }
    }),

  /**
   * Rename a computer (what Settings and every computer picker show). The manager's,
   * as for disable. Not the desktop app's own computer on its own hub, and never TO
   * the name that hub reserves for it: the hub picks its default computer by that
   * name, so a second one would take its place.
   */
  rename: publicProcedure
    .input(z.object({ computerId: z.string(), name: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input, path }) => {
      await requireManager(ctx, path, input.computerId)
      if (isProtectedLocal(input.computerId)) {
        throw stateRefusal('BAD_REQUEST', computerIsLocalError('renamed'))
      }
      if (input.name === DEFAULT_LOCAL_COMPUTER_NAME) {
        throw stateRefusal('BAD_REQUEST', computerNameReservedError(input.name))
      }
      await storeRenameComputer(ctx.db, input.computerId, input.name)
      auditComputer('computer.rename', input.computerId)
      return { ok: true as const }
    }),

  /**
   * Disable (`disabled: true`) or enable a computer. A disabled computer stays
   * enrolled, listed and connected, but gets no new work: placement leaves it out of
   * every default pick, nothing new may be bound to it, and the hub refuses to start
   * a terminal, agent or process on it (the spawn guard in `apps/hub` composition).
   *
   * Refused while terminals or agents run on it — the operator stops them first, so a
   * disable never strands work — and for the desktop app's own computer on its own
   * hub, without which nothing on the machine could run. Enabling has no such check.
   * Who may: the computer's manager (its owner, or an admin), as for revoke.
   */
  setDisabled: publicProcedure
    .input(z.object({ computerId: z.string(), disabled: z.boolean() }))
    .mutation(async ({ ctx, input, path }) => {
      await requireManager(ctx, path, input.computerId)
      if (input.disabled) {
        if (isProtectedLocal(input.computerId)) {
          throw stateRefusal('BAD_REQUEST', computerIsLocalError('disabled'))
        }
        const row = await storeGetComputer(ctx.db, input.computerId)
        const runningWorkOn = getComputersDepsOrNull()?.runningWorkOn
        const running = runningWorkOn ? await runningWorkOn(input.computerId) : null
        if (running === null) {
          throw new Error('cannot tell what runs on this computer yet; try again in a moment')
        }
        if (running > 0) {
          throw stateRefusal('PRECONDITION_FAILED', computerHasRunningWorkError(running, row?.name))
        }
      }
      await storeSetComputerDisabled(ctx.db, input.computerId, input.disabled)
      auditComputer(input.disabled ? 'computer.disable' : 'computer.enable', input.computerId)
      // Placement's default pick changes with it, exactly as a binding change does.
      notifyComputerBindingChanged()
      return { ok: true as const }
    }),

  /**
   * Connection changes, pushed.
   *
   * Fed by the gateway events that ALREADY exist — `computer-connected`,
   * `computer-disconnected` and the watchdog's `computer-lost`. Until now their
   * only consumer was exec-proxies disposing pty sessions, so every signal the
   * system computed about a computer going away was thrown at the wall: the
   * Settings list had no polling and refreshed only when a human clicked.
   *
   * Deliberately NOT fed by the computer's own HubDialer events. Those live in
   * the computer's process and exist only while it is running — the hub cannot
   * learn "the computer is gone" from a process that is gone. The silent-but-open
   * case is covered here too, because the watchdog fires `computer-lost` after
   * the heartbeat window.
   *
   * Emits an id, not a row: the row carries machine and ownership fields this
   * event knows nothing about, so the client invalidates and refetches.
   *
   * On a hub with login each subscriber hears only about the computers it may see in
   * `list` (its own; every one for an admin), decided per event in arrival order.
   */
  onStatusChange: publicProcedure.subscription(({ ctx }) =>
    observable<{ computerId: string; connected: boolean }>((emit) => {
      const subscribe = getComputersDepsOrNull()?.subscribeComputerStatus
      if (!subscribe) return () => undefined
      const access = managerAccessOf(ctx)
      if (!access.enforcing) return subscribe((change) => emit.next(change))
      let closed = false
      let tail: Promise<void> = Promise.resolve()
      const unsubscribe = subscribe((change) => {
        tail = tail.then(async () => {
          const allowed = await access.mayManage(change.computerId).catch(() => false)
          if (allowed && !closed) emit.next(change)
        })
      })
      return () => {
        closed = true
        unsubscribe()
      }
    })
  ),

  /** Revoke a computer (idempotent — first revocation time wins). */
  revokeComputer: publicProcedure
    .input(z.object({ computerId: z.string() }))
    .mutation(async ({ ctx, input, path }) => {
      await requireManager(ctx, path, input.computerId)
      await storeRevokeComputer(ctx.db, input.computerId)
      // As the REST twin does: a revoked computer stops working now, not at its next dial.
      getComputersDepsOrNull()?.getGateway()?.disconnect?.(input.computerId, 'computer revoked')
      auditComputer('computer.revoke', input.computerId)
      getComputersDepsOrNull()?.onComputerRemoved?.(input.computerId)
      return { ok: true as const }
    })
})

/** Reverse of the enroll-time capability map (`{ tag: true }`) → tag list. Also
 *  tolerates a bare array. Anything else → []. */
function parseCapabilities(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (Array.isArray(parsed)) return parsed.filter((e): e is string => typeof e === 'string')
    if (parsed !== null && typeof parsed === 'object') return Object.keys(parsed as object)
  } catch {
    /* malformed — no capabilities */
  }
  return []
}

export type ComputersRouter = typeof computersRouter
/** Where `@slayzone/api` mounts it: `computers`. */
export type ComputersMounts = { computers: ComputersRouter }
