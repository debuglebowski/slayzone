import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '../trpc'
import { getComputersDeps, getComputersDepsOrNull } from '../app-deps'
import {
  listComputers as storeListComputers,
  mintJoinToken as storeMintJoinToken,
  revokeComputer as storeRevokeComputer,
  unrevokeComputer as storeUnrevokeComputer,
  deleteComputer as storeDeleteComputer,
  setProjectDefaultComputer as storeSetProjectDefaultComputer,
  setTaskComputer as storeSetTaskComputer,
  resolveTaskComputerId as storeResolveTaskComputerId,
  machinesByHostId as storeMachinesByHostId,
  renameMachine as storeRenameMachine,
  assertComputerVisible,
  listVisibleComputerIds,
  claimComputer as storeClaimComputer,
  setComputerVisibility as storeSetComputerVisibility,
  type ComputerViewer
} from '@slayzone/computers/server'

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
 *    read the injected `ComputersDeps` (the gateway + hub URL + cert fingerprint).
 *    `list` degrades gracefully when the gateway isn't wired (store rows with a
 *    `connected: false` status); `mintJoinToken` REQUIRES it and throws a clear
 *    error before the listener has bound — minting a token for a hub that isn't
 *    listening would hand a computer an un-dialable URL.
 *
 * Follows the `processesRouter` conventions: `ctx.db`, `publicProcedure`, zod
 * inputs. Registered as `computers` in router.ts.
 */

const DEFAULT_JOIN_TOKEN_TTL_MS = 15 * 60_000 // 15 minutes

/**
 * Whose view this request runs in. `principal` is null on a supervised hub, where
 * the Electron host owns the process and there is exactly one human — filtering
 * there would break the desktop app for no gain.
 */
const viewerOf = (ctx: { principal?: { userId?: string } | null }): ComputerViewer => ({
  userId: ctx.principal?.userId ?? null
})

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
      // Same predicate the binding guards use — a list that shows a computer a
      // mutation would refuse (or worse, hides one it would accept) is the drift
      // this shares one implementation to avoid.
      const visible = await listVisibleComputerIds(ctx.db, viewerOf(ctx))
      // One query for the whole list rather than a join per row: the machine is
      // decoration, and a computer with no host id is legitimately ungrouped.
      const machines = await storeMachinesByHostId(ctx.db)
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
            capabilities: parseCapabilities(row.capabilities_json),
            lastSeenAt: row.last_seen_at,
            createdAt: row.created_at,
            connected: conn !== undefined,
            usable: usableIds.has(row.id),
            connectedAt: conn?.connectedAt ?? null,
            revokedAt: row.revoked_at,
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
   * and TLS cert fingerprint (both sourced from the injected deps), so it can
   * only be minted once the hub listener has bound.
   *
   * `hubUrl` is returned alongside the token so a client can tell whether the
   * token is usable off-box (see `isLoopbackComputerUrl`) WITHOUT decoding it —
   * `decodeJoinToken` needs `Buffer`, which the renderer does not have. It is not
   * a secret: it is embedded in the token the caller already receives in full.
   * The REST twin has always returned it; this closes that shape gap.
   */
  mintJoinToken: publicProcedure
    .input(
      z.object({
        label: z.string().min(1),
        ttlMs: z.number().int().positive().optional()
      })
    )
    .mutation(async ({ ctx, input }) => {
      const deps = getComputersDeps()
      const hubUrl = deps.getHubUrl()
      const certFingerprint = deps.getCertFingerprint()
      if (!hubUrl || !certFingerprint) {
        throw new Error(
          'cannot mint join token — the computer listener has not bound its URL / hub identity yet'
        )
      }
      const minted = await storeMintJoinToken(ctx.db, {
        hubUrl,
        certFingerprint,
        ttlMs: input.ttlMs ?? DEFAULT_JOIN_TOKEN_TTL_MS,
        label: input.label,
        // Carries this user onto the computer that redeems the token. Null on an
        // unauthenticated loopback hub (the normal local case), which leaves the
        // computer honestly unowned rather than attributed to a guess.
        mintedByUserId: ctx.principal?.userId ?? null
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

  /** Pin a task to a computer (`null` = inherit the project default). */
  setTaskComputer: publicProcedure
    .input(z.object({ taskId: z.string(), computerId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      // Binding a task to a computer is code execution in that computer's $HOME.
      await assertComputerVisible(ctx.db, input.computerId, viewerOf(ctx))
      await storeSetTaskComputer(ctx.db, input.taskId, input.computerId)
      return { ok: true as const }
    }),

  /** Set a project's default computer (`null` = no explicit default; exec falls back
   *  to the connected default computer, else in-process). */
  setProjectDefaultComputer: publicProcedure
    .input(z.object({ projectId: z.string(), computerId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await assertComputerVisible(ctx.db, input.computerId, viewerOf(ctx))
      await storeSetProjectDefaultComputer(ctx.db, input.projectId, input.computerId)
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
    .mutation(async ({ ctx, input }) => {
      await storeRenameMachine(ctx.db, input.hostId, input.name)
      return { ok: true as const }
    }),

  /**
   * Take ownership of an UNOWNED computer.
   *
   * Every row is unowned today (v161 did not backfill — inventing an owner is a
   * claim about whose machine it is that nothing knows), so this is the path from
   * "visible to everyone" to actually private. Never reassigns an owned one.
   */
  claim: publicProcedure
    .input(z.object({ computerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.principal?.userId
      if (!userId) throw new Error('sign in to claim a computer')
      return { claimed: await storeClaimComputer(ctx.db, input.computerId, userId) }
    }),

  /** Private (owner + grants), or visible to everyone on this hub. */
  setVisibility: publicProcedure
    .input(z.object({ computerId: z.string(), visibility: z.enum(['private', 'hub', 'shared']) }))
    .mutation(async ({ ctx, input }) => {
      await assertComputerVisible(ctx.db, input.computerId, viewerOf(ctx))
      await storeSetComputerVisibility(ctx.db, input.computerId, input.visibility)
      return { ok: true as const }
    }),

  /**
   * Clear a revocation.
   *
   * Not enough on its own to bring the computer back: revoking made its next
   * `hello` fatal, so the process exited and its supervisor latched. Un-revoking
   * is half a RE-INVITE — the caller mints a fresh join token and hands it over.
   */
  unrevoke: publicProcedure
    .input(z.object({ computerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertComputerVisible(ctx.db, input.computerId, viewerOf(ctx))
      await storeUnrevokeComputer(ctx.db, input.computerId)
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
    .mutation(async ({ ctx, input }) => {
      await assertComputerVisible(ctx.db, input.computerId, viewerOf(ctx))
      await storeDeleteComputer(ctx.db, input.computerId)
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
   */
  onStatusChange: publicProcedure.subscription(() =>
    observable<{ computerId: string; connected: boolean }>((emit) => {
      const subscribe = getComputersDepsOrNull()?.subscribeComputerStatus
      if (!subscribe) return () => undefined
      return subscribe((change) => emit.next(change))
    })
  ),

  /** Revoke a computer (idempotent — first revocation time wins). */
  revokeComputer: publicProcedure
    .input(z.object({ computerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertComputerVisible(ctx.db, input.computerId, viewerOf(ctx))
      await storeRevokeComputer(ctx.db, input.computerId)
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
