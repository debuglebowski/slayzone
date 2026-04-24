import type { Database } from 'better-sqlite3'

export interface RestApiDeps {
  db: Database
  notifyRenderer: () => void
  automationEngine?: { executeManual(id: string): Promise<unknown> }
}
