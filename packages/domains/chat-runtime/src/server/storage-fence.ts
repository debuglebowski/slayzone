import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

/**
 * A real FULL commit covers the preceding NORMAL WAL prefix, including when its
 * background checkpointer failed. A pragma change or empty transaction does not.
 *
 * Owner-worker primitive: never call this from the computer's main thread. The
 * caller may acknowledge its committed prefix only after this returns successfully.
 * Keep FULL after a failure (and while the periodic checkpointer is unavailable).
 */
export function commitStorageFence(
  db: Database.Database,
  opts: { resumeNormal?: boolean } = {}
): string {
  if (db.inTransaction) throw new Error('A storage fence must run outside a transaction')
  const nonce = randomUUID()
  db.pragma('synchronous = FULL')
  db.transaction(() => {
    db.prepare(
      `INSERT INTO maintenance_cursors(id,value) VALUES('storage-durable-prefix-v1',?)
       ON CONFLICT(id) DO UPDATE SET value=excluded.value`
    ).run(JSON.stringify(nonce))
  }).immediate()
  if (opts.resumeNormal) db.pragma('synchronous = NORMAL')
  return nonce
}
