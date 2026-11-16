/**
 * v193: agent_sessions lookups by conversation_id are indexed. The one-time legacy
 * diagnostics attribution at first boot after the computer-owned chat upgrade looks
 * up every held row's session id this way; unindexed, each lookup scanned every
 * session (75k rows × 3k sessions ≈ 56s of a blocked hub).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v193-agent-sessions-conversation-index-migration.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from './index'

function migrated(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Through v205: v206 moved the ledger to the computer (its own index there).
  for (const m of migrations.filter((m) => m.version <= 205))
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  return db
}

test('session lookup by id or conversation_id uses indexes, never a full scan', () => {
  const db = migrated()
  try {
    const plan = (
      db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT DISTINCT task_id FROM agent_sessions WHERE (id=? OR conversation_id=?) AND task_id IS NOT NULL'
        )
        .all('x', 'x') as { detail: string }[]
    ).map((r) => r.detail)
    // Both OR arms resolve through an index: the primary key for id, v193's index for
    // conversation_id. Without it SQLite falls back to walking every task's sessions.
    expect(plan.join('\n')).toMatch(
      /USING INDEX agent_sessions_conversation \(conversation_id=\?\)/
    )
  } finally {
    db.close()
  }
})
