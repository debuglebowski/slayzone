import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import { settingScope } from './scope'

/**
 * Hand every `user`-scoped row of the global `settings` table to `userId`: copy it
 * into their `user_settings`, then drop the global copy. Returns how many keys
 * moved. One transaction; idempotent (a second run finds nothing to move).
 *
 * WHEN: the hub's boot backfill (`apps/hub/src/ownership-backfill.ts`), on a hub
 * that requires login, with its first admin — the same person who receives the
 * unowned projects. Those rows are the state of whoever used the hub before login
 * (open tabs, layout, filters of the projects they now own), and on a login hub
 * nothing reads a global `user` row any more (scope.ts: no fallback), so leaving
 * them would only keep a stale `viewState` steering the boot purge forever.
 *
 * NEVER CLOBBERS: a key the user already has keeps their value (INSERT OR IGNORE)
 * and the global copy goes. That case needs login to have been turned off and on
 * again, and the value lost is UI state written while nobody was signed in.
 */
export async function adoptLegacyUserSettings(db: SlayzoneDb, userId: string): Promise<number> {
  const rows = await db.all<{ key: string }>('SELECT key FROM settings')
  const keys = rows.map((r) => r.key).filter((key) => settingScope(key) === 'user')
  if (keys.length === 0) return 0
  const ops: BatchOp[] = keys.flatMap((key) => [
    {
      type: 'run' as const,
      sql: `INSERT OR IGNORE INTO user_settings (user_id, key, value)
            SELECT ?, key, value FROM settings WHERE key = ?`,
      params: [userId, key]
    },
    { type: 'run' as const, sql: 'DELETE FROM settings WHERE key = ?', params: [key] }
  ])
  await db.batchTxn(ops)
  return keys.length
}
