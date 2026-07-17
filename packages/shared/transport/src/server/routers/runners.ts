import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { getRunnersDeps, getRunnersDepsOrNull } from '../app-deps'
import {
  listRunners as storeListRunners,
  mintJoinToken as storeMintJoinToken,
  revokeRunner as storeRevokeRunner,
  setProjectDefaultRunner as storeSetProjectDefaultRunner,
  setTaskRunner as storeSetTaskRunner,
  resolveTaskRunnerId as storeResolveTaskRunnerId
} from '@slayzone/runners/server'

/**
 * Runners router — the tRPC surface over the hub/runner-split runner (hub side).
 *
 * Two dependency classes, deliberately separated so the router keeps working
 * with runner mode OFF:
 *
 *  - Pure runner-binding CRUD (`list` store rows, `setTaskRunner`,
 *    `setProjectDefaultRunner`, `revokeRunner`) goes straight through `ctx.db`
 *    against the v149 runner tables. These never need the live gateway, so they
 *    work regardless of runner mode (the UI that calls them is wave 3).
 *  - Live-runner operations (`list` connection-status merge, `mintJoinToken`)
 *    read the injected `RunnersDeps` (the gateway + hub URL + cert fingerprint).
 *    `list` degrades gracefully when the gateway isn't wired (store rows with a
 *    `connected: false` status); `mintJoinToken` REQUIRES it and throws a clear
 *    error when runner mode is off — minting a token for a hub that isn't
 *    listening would hand a runner an un-dialable URL.
 *
 * Follows the `processesRouter` conventions: `ctx.db`, `publicProcedure`, zod
 * inputs. Registered as `runners` in router.ts.
 */

const DEFAULT_JOIN_TOKEN_TTL_MS = 15 * 60_000 // 15 minutes

export const runnersRouter = router({
  /**
   * All non-revoked runners from the store, each annotated with live connection
   * status merged from the runner gateway (when wired). A runner in the store but
   * not currently dialed in reports `connected: false`.
   */
  list: publicProcedure.query(async ({ ctx }) => {
    const rows = await storeListRunners(ctx.db)
    const deps = getRunnersDepsOrNull()
    const live = deps?.getGateway()?.listRunners() ?? []
    const liveById = new Map(live.map((r) => [r.runnerId, r]))
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
        connectedAt: conn?.connectedAt ?? null
      }
    })
  }),

  /**
   * Mint a single-use enrollment token. The token embeds the hub's runner WS URL
   * and TLS cert fingerprint (both sourced from the injected deps), so it can
   * only be minted when runner mode is on and the hub is listening.
   */
  mintJoinToken: publicProcedure
    .input(
      z.object({
        label: z.string().min(1),
        ttlMs: z.number().int().positive().optional()
      })
    )
    .mutation(async ({ ctx, input }) => {
      const deps = getRunnersDeps()
      const hubUrl = deps.getHubUrl()
      const certFingerprint = deps.getCertFingerprint()
      if (!hubUrl || !certFingerprint) {
        throw new Error(
          'cannot mint join token — the runner listener has not bound its URL / hub identity yet'
        )
      }
      const minted = await storeMintJoinToken(ctx.db, {
        hubUrl,
        certFingerprint,
        ttlMs: input.ttlMs ?? DEFAULT_JOIN_TOKEN_TTL_MS,
        label: input.label
      })
      return {
        id: minted.id,
        token: minted.token,
        label: minted.label,
        createdAt: minted.created_at,
        expiresAt: minted.expires_at
      }
    }),

  /** Pin a task to a runner (`null` = inherit the project default). */
  setTaskRunner: publicProcedure
    .input(z.object({ taskId: z.string(), runnerId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await storeSetTaskRunner(ctx.db, input.taskId, input.runnerId)
      return { ok: true as const }
    }),

  /** Set a project's default runner (`null` = local/first runner). */
  setProjectDefaultRunner: publicProcedure
    .input(z.object({ projectId: z.string(), runnerId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await storeSetProjectDefaultRunner(ctx.db, input.projectId, input.runnerId)
      return { ok: true as const }
    }),

  /** Effective runner for a task (task binding → project default → null). */
  resolveTaskRunner: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(async ({ ctx, input }) => {
      const runnerId = await storeResolveTaskRunnerId(ctx.db, input.taskId)
      return { runnerId }
    }),

  /** Revoke a runner (idempotent — first revocation time wins). */
  revokeRunner: publicProcedure
    .input(z.object({ runnerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await storeRevokeRunner(ctx.db, input.runnerId)
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
