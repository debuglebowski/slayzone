import { typedTrpc, type ResolvedHub } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { NotifyMounts } from '@slayzone/notify/server'
import type { ProjectsMounts } from '@slayzone/projects/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { TaskMounts } from '@slayzone/task/server'
import type { PtyMounts } from '@slayzone/terminal/server'

/**
 * This package's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers tasks calls: `task`, `projects` + `projectGroups`,
 * `pty`, `settings` and `notify`.
 */
export const { useTRPC, useTRPCClient, getTrpcClient, getClientForHub } = typedTrpc<
  TaskMounts & ProjectsMounts & PtyMounts & SettingsMounts & NotifyMounts
>()

/** A vanilla client typed by this view. */
export type TasksTrpcClient = ReturnType<typeof getTrpcClient>

/**
 * A federation-resolved hub's client (`FederationProvider` hands it out router-agnostic),
 * re-typed through this view. Sound for the same reason the view itself is: clients are
 * path-based and api asserts every slice above is mounted at the same keys.
 */
export function tasksClientOf(ws: ResolvedHub['ws']): TasksTrpcClient {
  return ws.client as unknown as TasksTrpcClient
}
