import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { ProjectsMounts } from '@slayzone/projects/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { TagsMounts } from '@slayzone/tags/server'
import type { TaskMounts } from '@slayzone/task/server'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers home calls: `projects`, `tags`, `task` and `settings`.
 */
export const { useTRPCClient } = typedTrpc<
  ProjectsMounts & TagsMounts & TaskMounts & SettingsMounts
>()
