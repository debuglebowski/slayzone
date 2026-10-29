import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type {
  AppClipboardMounts,
  AppDialogMounts,
  AppShellMounts
} from '@slayzone/host-capabilities/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { ArtifactsMounts } from '../server/artifacts-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers task-artifacts calls: its own `artifacts`, `settings`,
 * `app.clipboard`, `app.dialog` and `app.shell`.
 */
export const { useTRPC, useTRPCClient } = typedTrpc<
  ArtifactsMounts & SettingsMounts & AppClipboardMounts & AppDialogMounts & AppShellMounts
>()
