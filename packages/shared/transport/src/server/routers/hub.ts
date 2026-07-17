import { z } from 'zod'
import { SettingsService } from '@slayzone/settings/server'
import { router, publicProcedure, openProcedure } from '../trpc'
import { getAppDeps, getHubDescribeDepsOrNull } from '../app-deps'

/**
 * Hub router — the client-facing identity surface of a hub (multi-hub
 * federation).
 *
 * A "hub" is a full data server (owns a DB + all routers/auth). The desktop
 * client can connect to several at once; on connect it calls `hub.describe` to
 * learn the hub's stable identity + human label so it can reconcile the local
 * registry (detect a hub swapped behind a reused URL) and render a name.
 *
 * `describe` degrades gracefully so it works with multi_hub OFF and on the plain
 * local sidecar (no cert, no auth): the identity deps (`HubDescribeDeps`) are
 * optional and both fields fall back to a safe default when unwired. The label
 * is stored as a plain settings k/v (`hub_label`) — no migration — and defaults
 * to the app version's product name is left to the client; the hub only reports
 * a stored override.
 *
 * This is the `/trpc` (client↔hub) axis — deliberately distinct from the
 * `runners` router's `/runners` (hub↔runner) axis.
 */

const HUB_LABEL_KEY = 'hub_label'

export const hubRouter = router({
  /**
   * Intrinsic identity of THIS hub, for a connecting client. `fingerprint` is
   * the hub's own TLS leaf sha256 (null on the plain local sidecar);
   * `authRequired` reports whether `/trpc` enforces bearer auth (Phase 6; false
   * today). `label` is the stored display-name override or null.
   */
  describe: openProcedure.query(async ({ ctx }) => {
    const deps = getHubDescribeDepsOrNull()
    const label = (await SettingsService.forDatabase(ctx.db).get(HUB_LABEL_KEY)) ?? null
    return {
      label,
      version: getAppDeps().appGetVersion(),
      fingerprint: deps?.getFingerprint() ?? null,
      authRequired: deps?.getAuthRequired() ?? false
    }
  }),

  /** Persist a display-name override for this hub (empty string clears it). */
  setLabel: publicProcedure
    .input(z.object({ label: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await SettingsService.forDatabase(ctx.db).set(HUB_LABEL_KEY, input.label.trim())
      return { ok: true as const }
    })
})
