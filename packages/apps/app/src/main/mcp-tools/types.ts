import type { Database } from 'better-sqlite3'

export interface McpToolsDeps {
  db: Database
  notifyRenderer: () => void
}
