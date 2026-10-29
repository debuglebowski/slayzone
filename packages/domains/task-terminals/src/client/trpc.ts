import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AgentTurnsMounts } from '@slayzone/agent-turns/server'
import type { DiagnosticsMounts } from '@slayzone/diagnostics/server'
import type { AppShellMounts, AppTaskWindowsMounts } from '@slayzone/host-capabilities/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { ChatMounts, PtyMounts } from '@slayzone/terminal/server'
import type { TaskTerminalsMounts } from '../server/task-terminals-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers task-terminals calls: its own `taskTerminals`, plus
 * `pty`, `chat`, `agentPrompts`, `diagnostics`, `settings`, `app.shell`, `app.taskWindows`.
 */
export const { useTRPC, useTRPCClient, getTrpcClient } = typedTrpc<
  TaskTerminalsMounts &
    PtyMounts &
    ChatMounts &
    AgentTurnsMounts &
    DiagnosticsMounts &
    SettingsMounts &
    AppShellMounts &
    AppTaskWindowsMounts
>()
