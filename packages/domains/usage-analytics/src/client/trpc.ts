import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { PtyMounts } from '@slayzone/terminal/server'
import type { UsageAnalyticsMounts } from '../server/usage-analytics-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers usage-analytics calls: its own `usageAnalytics`,
 * `settings` and `pty`.
 */
export const { useTRPC } = typedTrpc<UsageAnalyticsMounts & SettingsMounts & PtyMounts>()
