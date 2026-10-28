import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The router's runtime stays server-side.
import type { AppMetaMounts } from '@slayzone/host-capabilities/server'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the router app-shell calls: `app.meta`.
 */
export const { useTRPC } = typedTrpc<AppMetaMounts>()
