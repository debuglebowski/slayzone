import type { Database } from 'better-sqlite3'
import type { EventEmitter } from 'node:events'

export interface McpToolsDeps {
  db: Database
  notifyRenderer: () => void
  /** Optional menu/app event bus. update_task uses this to emit close-task when
   *  the close flag is set. Standalone server may pass undefined; the close
   *  flag becomes a no-op. */
  menuEvents?: EventEmitter
}
