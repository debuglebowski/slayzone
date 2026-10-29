import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { ComputersMounts } from '@slayzone/computers/server'
import type { WorkspaceMounts } from '@slayzone/file-editor/server'
import type { HistoryMounts } from '@slayzone/history/server'
import type {
  AppMetaMounts,
  AppScreenshotMounts,
  AppShellMounts,
  AppTaskWindowsMounts,
  AppWindowMounts,
  MenuMounts
} from '@slayzone/host-capabilities/server'
import type { NotifyMounts } from '@slayzone/notify/server'
import type { ProcessesMounts } from '@slayzone/processes/server'
import type { ProjectsMounts } from '@slayzone/projects/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { TagsMounts } from '@slayzone/tags/server'
import type { PtyMounts } from '@slayzone/terminal/server'
import type { TaskMounts } from '../server/router-mounts'

/**
 * Every router task's UI calls: its own `task`, `agentSessions` and `template`, plus
 * `tags`, `history`, `workspace`, `projects`, `settings`, `computers`, `processes`,
 * `pty`, `menu`, `notify` and `app.{meta,screenshot,shell,taskWindows,window}`.
 */
type TaskClientMounts = TaskMounts &
  TagsMounts &
  HistoryMounts &
  WorkspaceMounts &
  ProjectsMounts &
  SettingsMounts &
  ComputersMounts &
  ProcessesMounts &
  PtyMounts &
  MenuMounts &
  NotifyMounts &
  AppMetaMounts &
  AppScreenshotMounts &
  AppShellMounts &
  AppTaskWindowsMounts &
  AppWindowMounts

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers task calls. Domain client code imports these, never
 * the whole-app view of `@slayzone/transport/client`.
 */
export const {
  useTRPC,
  useTRPCClient,
  getTrpcClient,
  getHubClient,
  useClientForProject,
  useClientForTask
} = typedTrpc<TaskClientMounts>()

/** A vanilla client typed against this domain's view. */
export type TaskTrpcClient = ReturnType<typeof getTrpcClient>
