import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppTaskWindowsMounts } from '@slayzone/host-capabilities/server'
import type { SettingsMounts } from '@slayzone/settings/server'
import type { PtyMounts } from '@slayzone/terminal/server'
import type { AppFloatingAgentMounts } from './server'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers agent-panels calls: its own `app.floatingAgent`,
 * `app.taskWindows`, `pty` and `settings`.
 */
export const { useTRPC, useTRPCClient, getTrpcClient } = typedTrpc<
  AppFloatingAgentMounts & AppTaskWindowsMounts & PtyMounts & SettingsMounts
>()
