/**
 * This computer's read offsets into its agents' usage logs (robustness plan §9, P0;
 * hub v209): kept in its per-hub chat store, the only copy. The usage collector
 * (`@slayzone/usage-analytics/collect` collector.ts) reads them, seeds them once from
 * the hub's former cursors (a cursor kept here wins) and moves them only after the
 * hub acknowledged the page that stored their records.
 *
 * @module chat-runtime/server/usage-cursors
 */
import type { ChatStorage } from './storage'

export type UsageCursorMap = Record<string, { offset: number; modifiedMs: number }>

export function usageCursorStore(storage: ChatStorage) {
  const db = storage.compose((raw) => raw)
  return {
    all(): UsageCursorMap {
      const out: UsageCursorMap = {}
      for (const r of db
        .prepare('SELECT file_path, offset, modified_ms FROM usage_cursors')
        .all() as Array<{ file_path: string; offset: number; modified_ms: number }>)
        out[r.file_path] = { offset: r.offset, modifiedMs: r.modified_ms }
      return out
    },
    seed(cursors: UsageCursorMap): void {
      const insert = db.prepare(
        'INSERT OR IGNORE INTO usage_cursors(file_path, offset, modified_ms) VALUES (?,?,?)'
      )
      db.transaction(() => {
        for (const [file, c] of Object.entries(cursors)) insert.run(file, c.offset, c.modifiedMs)
      })()
    },
    commit(entries: Array<{ sourceFile: string; offset: number; modifiedMs: number }>): void {
      const upsert = db.prepare(
        `INSERT INTO usage_cursors(file_path, offset, modified_ms) VALUES (?,?,?)
         ON CONFLICT(file_path) DO UPDATE SET offset=excluded.offset, modified_ms=excluded.modified_ms`
      )
      db.transaction(() => {
        for (const e of entries) upsert.run(e.sourceFile, e.offset, e.modifiedMs)
      })()
    }
  }
}
