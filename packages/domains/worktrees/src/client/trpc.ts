import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppShellMounts } from '@slayzone/host-capabilities/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { TaskMounts } from '@slayzone/task/server'
import type { WorktreesMounts } from '../server/worktrees-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers worktrees calls: its own `worktrees`, `task`,
 * `settings` and `app.shell`.
 */
export const { useTRPC, useTRPCClient } = typedTrpc<
  WorktreesMounts & TaskMounts & SettingsMounts & AppShellMounts
>()
