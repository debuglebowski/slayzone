import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { HistoryMounts } from '@slayzone/history/server'
import type { TagsMounts } from '@slayzone/tags/server'
import type { PtyMounts } from '@slayzone/terminal/server'
import type { AutomationsMounts } from '../server/automations-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers automations calls: its own `automations`, `history`,
 * `tags` and `pty`.
 */
export const { useTRPC } = typedTrpc<AutomationsMounts & HistoryMounts & TagsMounts & PtyMounts>()
