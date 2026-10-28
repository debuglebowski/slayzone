import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type {
  AppAuthMounts,
  AppMetaMounts,
  AppShellMounts
} from '@slayzone/host-capabilities/server'
import type { AppLeaderboardMounts } from '@slayzone/usage-analytics/server'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers the leaderboard calls: `app.auth`, `app.leaderboard`,
 * `app.meta`, `app.shell`.
 */
export const { useTRPCClient } = typedTrpc<
  AppAuthMounts & AppLeaderboardMounts & AppMetaMounts & AppShellMounts
>()
