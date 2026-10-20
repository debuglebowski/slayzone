import { z } from 'zod'
import { HUB_SWITCH_DEFAULTS } from '@slayzone/platform'
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
 * local sidecar (no auth): the identity deps (`HubDescribeDeps`) are optional and
 * their fields fall back to a safe default when unwired. The label
 * is stored as a plain settings k/v (`hub_label`) — no migration — and defaults
 * to the app version's product name is left to the client; the hub only reports
 * a stored override.
 *
 * This is the `/trpc` (client↔hub) axis — deliberately distinct from the
 * `computers` router's `/computers` (hub↔computer) axis.
 */

const HUB_LABEL_KEY = 'hub_label'

export const hubRouter = router({
  /**
   * Intrinsic identity of THIS hub, for a connecting client. `authRequired`
   * reports whether `/trpc` enforces bearer auth (the `REQUIRE_LOGIN` switch);
   * `switches` reports every per-hub switch (login, password, SSO, processes,
   * integrations). `label` is the stored display-name override or null.
   *
   * `fingerprint` is always null: the hub no longer terminates TLS or presents a
   * certificate of its own (a front end does), so there is nothing to pin. The
   * field stays in the shape until the pin code in the clients is removed, so an
   * older client that reads it sees "not pinned" instead of `undefined`.
   */
  describe: openProcedure.query(async ({ ctx }) => {
    const deps = getHubDescribeDepsOrNull()
    const label = (await SettingsService.forDatabase(ctx.db).get(HUB_LABEL_KEY)) ?? null
    return {
      label,
      version: getAppDeps().appGetVersion(),
      fingerprint: null as string | null,
      authRequired: deps?.getAuthRequired() ?? false,
      switches: deps?.getSwitches() ?? { ...HUB_SWITCH_DEFAULTS }
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
