import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle.
import type { SettingsMounts } from '@slayzone/settings-core/server'

/** This domain's typed view of the shared tRPC client: only `settings` (voice preferences). */
export const { useTRPCClient } = typedTrpc<SettingsMounts>()
