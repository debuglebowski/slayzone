import type { SlayzoneDb } from '@slayzone/platform'

export type StartServerConfig = {
  /** Override SLAYZONE_STORE_DIR. Defaults to ensureDataRoot(). */
  storeDir?: string
  /** Override SLAYZONE_PORT. 0 = OS-assigned. Defaults to env-or-0. */
  port?: number
  /** Override SLAYZONE_HOST. Defaults to 127.0.0.1. */
  host?: string
  /** Reserved for slice 3+. MCP is not started by the side-car this slice. */
  mcpPort?: number
  /**
   * Pre-opened DB handle. When provided the side-car does NOT open its own
   * (used by tests). Production passes undefined → db.ts opens its own.
   */
  db?: SlayzoneDb
}

export type ServerHandle = {
  /** Bound port (resolved from listen()). */
  port: number
  /** Bound host. */
  host: string
  /** Resolved data root used to open the DB. */
  dataRoot: string
  /** Absolute path of the SQLite file the side-car opened. */
  dbPath: string
  /** True once /health responds 200 OK. */
  healthCheck: () => Promise<boolean>
  /** Graceful shutdown. Idempotent. */
  stop: () => Promise<void>
}

export { startServer } from './server.js'
