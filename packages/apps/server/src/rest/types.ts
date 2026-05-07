import type { Database } from 'better-sqlite3'
import type { EventEmitter } from 'node:events'

export interface RestApiDeps {
  db: Database
  notifyRenderer: () => void
  automationEngine?: { executeManual(id: string): Promise<unknown> }
  /** Data root for artifacts/icons/uploads. Replaces electronApp.getPath('userData'). */
  dataRoot?: string
  /** OS temp dir. Replaces electronApp.getPath('temp'). */
  tempDir?: string
  /** Bus for menu/app events emitted to renderer (open-task, open-artifact, etc.).
   *  Routes that need it should call .emit() defensively. Optional so test
   *  harnesses can omit when the route under test doesn't reach a menu emit. */
  menuEvents?: EventEmitter
  /** Optional callback to focus the main window. No-op in standalone server. */
  focusMainWindow?: () => void
}
