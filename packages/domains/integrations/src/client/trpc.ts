import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppShellMounts } from '@slayzone/host-capabilities/server'
import type { TaskMounts } from '@slayzone/task/server'
import type { IntegrationsMounts } from '../server/integrations-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers integrations' UI calls: its own `integrations`,
 * `task` (a project's tasks, for sync status) and `app.shell`.
 */
export const { useTRPC, useTRPCClient } = typedTrpc<
  IntegrationsMounts & TaskMounts & AppShellMounts
>()
