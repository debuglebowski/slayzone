import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { TaskTerminalsMounts } from '@slayzone/task-terminals/server'
import type { PtyMounts } from '@slayzone/terminal/server'

/**
 * This package's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers tabs-state calls: `settings`, `taskTerminals`, `pty`.
 */
export const { getTrpcClient, getHubClient } = typedTrpc<
  SettingsMounts & TaskTerminalsMounts & PtyMounts
>()

/** The vanilla client of this view. */
export type TabsStateTrpcClient = ReturnType<typeof getTrpcClient>
