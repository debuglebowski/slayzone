/**
 * Minimal DB interface that both `better-sqlite3` (Database) and
 * `node:sqlite` (DatabaseSync) conform to. Lets the same versioning
 * logic run in the Electron main process AND the standalone CLI.
 */

export interface StatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface DbLike {
  prepare(sql: string): StatementLike
}

/**
 * Run a function inside a transaction. Caller provides the impl
 * matching their driver:
 *   better-sqlite3: (fn) => db.transaction(fn)()
 *   node:sqlite:    (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } }
 */
export type TxnRunner = <T>(fn: () => T) => T

/**
 * Helper: build a TxnRunner for `node:sqlite` style drivers (DatabaseSync, CLI's SlayDb).
 * Pass any object with a `.exec(sql: string): unknown` method.
 */
export function nodeSqliteTxn(db: { exec(sql: string): unknown }): TxnRunner {
  return <T>(fn: () => T): T => {
    db.exec('BEGIN')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // ignore rollback errors
      }
      throw err
    }
  }
}

/**
 * Helper: build a TxnRunner for `better-sqlite3` Database instances.
 */
export function betterSqliteTxn(db: { transaction<T>(fn: () => T): () => T }): TxnRunner {
  return <T>(fn: () => T): T => db.transaction(fn)()
}
