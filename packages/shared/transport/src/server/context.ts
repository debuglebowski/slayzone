import type { Database } from 'better-sqlite3'
import type { IncomingMessage } from 'node:http'

export interface AutomationEngineLike {
  executeManual(id: string): Promise<unknown>
}

export type TrpcServerDeps = {
  db: Database
  dataRoot: string
  /** SlayZone application version reported by health/migrate procedures.
   *  Embedded mode = Electron app version; standalone = `@slayzone/server` pkg version. */
  slayzoneVersion?: string
  /** Optional — only present in Electron-main host. Standalone server pkg
   *  may run without an engine for now. */
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
