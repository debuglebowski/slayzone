import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppMetaMounts } from '@slayzone/host-capabilities/server'
import type { FeedbackMounts } from '../server/feedback-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers feedback calls: its own `feedback` and `app.meta`.
 */
export const { useTRPCClient } = typedTrpc<FeedbackMounts & AppMetaMounts>()
