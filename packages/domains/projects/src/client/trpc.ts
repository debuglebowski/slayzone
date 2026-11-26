import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { ComputersMounts } from '@slayzone/computers/server'
import type { WorkspaceMounts } from '@slayzone/file-editor/server'
import type { AppDialogMounts } from '@slayzone/host-capabilities/server'
import type { PtyMounts } from '@slayzone/terminal/server'
import type { ProjectsMounts } from '../server/router-mounts'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers projects calls: its own `projects` + `projectGroups`,
 * plus `computers`, `workspace` (a project's folder on each computer), `pty` and `app.dialog`.
 */
export const { useTRPC, useTRPCClient, getHubClient } = typedTrpc<
  ProjectsMounts & ComputersMounts & WorkspaceMounts & PtyMounts & AppDialogMounts
>()
