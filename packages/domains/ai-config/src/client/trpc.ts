import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { AiConfigMounts } from '../server/ai-config-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers ai-config calls: its own `aiConfig` and `settings`.
 */
export const { useTRPCClient, getTrpcClient } = typedTrpc<AiConfigMounts & SettingsMounts>()
