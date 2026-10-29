import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppClipboardMounts, AppShellMounts } from '@slayzone/host-capabilities/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { FileEditorMounts } from '../server/file-editor-router'
import type { WorkspaceMounts } from '../server/workspace-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers file-editor calls: its own `fileEditor` and
 * `workspace`, `settings`, `app.clipboard` and `app.shell`.
 */
export const { useTRPC, useTRPCClient } = typedTrpc<
  FileEditorMounts & WorkspaceMounts & SettingsMounts & AppClipboardMounts & AppShellMounts
>()
