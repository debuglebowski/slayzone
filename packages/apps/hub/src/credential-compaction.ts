import type { SlayzoneDb } from '@slayzone/platform'

/**
 * Re-encrypting a `plain:` credential leaves its old bytes in the database file until a
 * VACUUM rewrites every page and the WAL is truncated (content-erasure compaction.ts).
 * Runs once, the first start after plaintext rows were migrated (integrations
 * credentials.ts flags it). The VACUUM holds the hub's only database connection for its
 * duration — logged, so a slow first start after an upgrade is explained — and
 * secure_delete is switched back off after, so later writes are not slowed (L8).
 * A failure throws and is retried at the next start.
 */
export async function compactAfterCredentialMigration(
  db: Pick<SlayzoneDb, 'exec' | 'all'>,
  log: (line: string) => void
): Promise<void> {
  const started = Date.now()
  await db.exec('PRAGMA secure_delete=ON')
  try {
    await db.exec('VACUUM')
    const checkpoint = await db.all<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
    if (checkpoint.some((row) => row.busy)) throw new Error('WAL checkpoint is busy')
  } finally {
    await db.exec('PRAGMA secure_delete=OFF')
  }
  log(
    `[hub] database compacted after re-encrypting plaintext credentials in ${Date.now() - started} ms`
  )
}
