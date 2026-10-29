import { convexOriginFromAddress } from '@slayzone/platform/hub-convex'

/**
 * e2e only (PLAYWRIGHT=1): the Convex deployment this app runs against instead of the
 * build's — a bare `host[:port]` (CLAUDE.md env rule 5: loopback → http, else
 * https), or empty for "Convex off".
 */
export const E2E_CONVEX_ADDRESS_ENV = 'SLAYZONE_E2E_CONVEX_ADDRESS'

/**
 * The ONE Convex deployment the desktop app uses, decided once in main and handed to
 * both its renderer (`app:get-boot-config` → `<ConvexAuthBootstrap convexUrl>`) and its
 * hub (`SLAYZONE_HUB_CONVEX_ADDRESS`), so the two always name the same deployment — the
 * hub refuses a sign-in for any other (T-99, platform/hub-convex.ts). '' = Convex off:
 * no leaderboard, no feedback entry point.
 *
 * Normally the build's `VITE_CONVEX_URL`, verbatim (trimmed only: the renderer keys its
 * stored Convex auth by this exact string, so normalising it would sign users out).
 *
 * Under Playwright, {@link E2E_CONVEX_ADDRESS_ENV} overrides it. Without that, whether
 * the Convex-gated UI exists at all is a property of whichever checkout built `out/` —
 * the main checkout's untracked `.env` bakes one in, a worktree's build has none — so
 * the leaderboard spec passed or failed on that. Throws on a value that is not a bare
 * `host[:port]`: a typo must fail the run, not silently fall back to the build's value.
 */
export function resolveAppConvexUrl(
  buildUrl: string,
  env: NodeJS.ProcessEnv,
  isPlaywright: boolean
): string {
  const override = isPlaywright ? env[E2E_CONVEX_ADDRESS_ENV]?.trim() : undefined
  if (override === undefined) return buildUrl.trim()
  if (override === '') return ''
  const origin = convexOriginFromAddress(override)
  if (origin === null)
    throw new Error(
      `${E2E_CONVEX_ADDRESS_ENV}=${JSON.stringify(override)} is not a bare host[:port]`
    )
  return origin
}
