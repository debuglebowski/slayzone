import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AiConfigMounts } from '@slayzone/ai-config/server'
import type { DiagnosticsMounts } from '@slayzone/diagnostics/server'
import type { AppFilesMounts, AppShellMounts } from '@slayzone/host-capabilities/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { ChatMounts } from '../server/chat-router'
import type { PtyMounts } from '../server/pty-router'

/** The routers terminal calls: its own `pty` and `chat`, plus `aiConfig`, `diagnostics`, `settings`, `app.files`, `app.shell`. */
export type TerminalClientMounts = PtyMounts &
  ChatMounts &
  AiConfigMounts &
  DiagnosticsMounts &
  SettingsMounts &
  AppFilesMounts &
  AppShellMounts

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers terminal calls.
 */
export const { useTRPC, useTRPCClient, getTrpcClient, listHubClients } =
  typedTrpc<TerminalClientMounts>()
