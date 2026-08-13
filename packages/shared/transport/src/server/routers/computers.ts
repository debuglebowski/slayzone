import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { getComputersDeps, getComputersDepsOrNull } from '../app-deps'
import {
  listComputers as storeListComputers,
  mintJoinToken as storeMintJoinToken,
  revokeComputer as storeRevokeComputer,
  setProjectDefaultComputer as storeSetProjectDefaultComputer,
  setTaskComputer as storeSetTaskComputer,
  resolveTaskComputerId as storeResolveTaskComputerId
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
  list: publicProcedure.query(async ({ ctx }) => {
    const rows = await storeListComputers(ctx.db)
    const deps = getComputersDepsOrNull()
    const gateway = deps?.getGateway()
    const live = gateway?.listComputers() ?? []
    const liveById = new Map(live.map((r) => [r.computerId, r]))
    const usableIds = new Set((gateway?.listUsableComputers() ?? []).map((r) => r.computerId))
    return rows.map((row) => {
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
        connectedAt: conn?.connectedAt ?? null
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
      await storeSetTaskComputer(ctx.db, input.taskId, input.computerId)
      return { ok: true as const }
    }),

  /** Set a project's default computer (`null` = no explicit default; exec falls back
   *  to the connected default computer, else in-process). */
  setProjectDefaultComputer: publicProcedure
    .input(z.object({ projectId: z.string(), computerId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
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

  /** Revoke a computer (idempotent — first revocation time wins). */
  revokeComputer: publicProcedure
    .input(z.object({ computerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
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
