import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppMetaMounts } from '@slayzone/host-capabilities/server'
import type { SettingsMounts } from '@slayzone/settings/server'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers onboarding calls: `app.meta` and `settings`.
 */
export const { useTRPC, useTRPCClient } = typedTrpc<AppMetaMounts & SettingsMounts>()
