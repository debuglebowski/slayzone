import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { ComputersMounts } from '@slayzone/computers/server'
import type { DiagnosticsMounts } from '@slayzone/diagnostics/server'
import type { WorkspaceMounts } from '@slayzone/file-editor/server'
import type { AppMetaMounts } from '@slayzone/host-capabilities/server'
import type { NotifyMounts } from '@slayzone/notify/server'
import type { ProjectsMounts } from '@slayzone/projects/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { TagsMounts } from '@slayzone/tags/server'
import type { AppUsageMounts } from '@slayzone/terminal/server'
import type { AppBackupMounts } from '../server/backup-router'
import type { AppExportImportMounts } from '../server/export-import-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers the settings UI calls: `settings`, its own
 * `app.backup` and `app.exportImport`, plus `computers`, `diagnostics`, `workspace`,
 * `projects`, `tags`, `notify`, `app.meta` and `app.usage`.
 */
export const { useTRPC, useTRPCClient } = typedTrpc<
  SettingsMounts &
    AppBackupMounts &
    AppExportImportMounts &
    ComputersMounts &
    DiagnosticsMounts &
    WorkspaceMounts &
    ProjectsMounts &
    TagsMounts &
    NotifyMounts &
    AppMetaMounts &
    AppUsageMounts
>()
