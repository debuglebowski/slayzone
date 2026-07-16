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
  /** Multi-hub auth: the authenticated principal for this connection, or null
   *  when the hub does not enforce auth (local loopback — the default). Attached
   *  in the hub's createContext from a bearer token in tRPC connectionParams. */
  principal?: { userId: string; orgId?: string | null } | null
}

export type TrpcContextFactory = (req?: IncomingMessage) => TrpcContext
