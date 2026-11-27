/**
 * The one-time compaction after plaintext credentials were re-encrypted (review-2 L8):
 * VACUUM + WAL truncate, with secure_delete switched back OFF afterwards (it would
 * otherwise slow every later write on the hub's only connection) and a log line saying
 * how long the hub's database was busy.
 */
import { expect, test } from 'vitest'
import { compactAfterCredentialMigration } from './credential-compaction.js'

function fakeDb(busy = 0) {
  const calls: string[] = []
  return {
    calls,
    db: {
      exec: async (sql: string) => {
        calls.push(sql)
      },
      all: async <T>(sql: string) => {
        calls.push(sql)
        return [{ busy }] as T[]
      }
    }
  }
}

test('VACUUM, truncate, secure_delete back OFF, and the duration logged', async () => {
  const { db, calls } = fakeDb()
  const lines: string[] = []
  await compactAfterCredentialMigration(db as never, (l) => lines.push(l))
  expect(calls).toEqual([
    'PRAGMA secure_delete=ON',
    'VACUUM',
    'PRAGMA wal_checkpoint(TRUNCATE)',
    'PRAGMA secure_delete=OFF'
  ])
  expect(lines.join('\n')).toMatch(/compacted .* in \d+ ms/)
})

test('a busy checkpoint fails (retried next start), secure_delete still switched back off', async () => {
  const { db, calls } = fakeDb(1)
  await expect(compactAfterCredentialMigration(db as never, () => {})).rejects.toThrow(/busy/)
  expect(calls.at(-1)).toBe('PRAGMA secure_delete=OFF')
})
