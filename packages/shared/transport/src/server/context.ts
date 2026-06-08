import type { SlayzoneDb } from '@slayzone/platform'
import type { AutomationRun } from '@slayzone/automations/shared'
import type { IncomingMessage } from 'node:http'

/** Structural slice of AutomationEngine the automations router needs. Keeps
 *  transport decoupled from the engine's electron-laden value module — only the
 *  pure `AutomationRun` type (from /shared) is imported. */
export interface AutomationEngineLike {
  executeManual(id: string): Promise<AutomationRun>
}

export type TrpcServerDeps = {
  db: SlayzoneDb
  dataRoot: string
  /** Optional — only the Electron-main host wires an engine. */
  automationEngine?: AutomationEngineLike
}

export type TrpcContext = TrpcServerDeps & {
  req?: IncomingMessage
  /** Per-WebSocket-connection window id, parsed from `?windowId=N` query.
   *  Used by task-windows panel ownership + primary-active tracking. May be
   *  null on standalone server connections (CLI, agents). */
  windowId?: number | null
}

export type TrpcContextFactory = (req?: IncomingMessage) => TrpcContext
