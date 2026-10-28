/**
 * A v0.35.0 (schema v145) database that holds ORPHAN rows must still migrate to latest.
 *
 * An orphan is a child row whose parent is gone — here a `task_conversations` row whose
 * task no longer exists. `foreign_keys = ON` plus `ON DELETE CASCADE` means a database the
 * app wrote cannot contain one, but one that was ever written with enforcement off
 * (a restored or hand-edited file, an external tool, a past bug) can. The v147 backfill
 * copies the ledger into `agent_sessions`, whose `task_id` is a real foreign key, so one
 * orphan made that INSERT throw — and a migration that throws rolls back and throws again
 * on every launch: the app can never start, though no data was ever at risk.
 *
 * Policy under test: the boot never blocks on a row that no task can reach. The orphan is
 * left out of the derived tables, every REACHABLE row crosses over untouched, and the
 * chain reaches the latest version.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/orphan-rows-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { migrations, runMigrations } from './index'

const LATEST = migrations[migrations.length - 1].version

/** A database exactly as v0.35.0 leaves it: migrated to v145, enforcement on. */
function dbAtV145(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.version > 145) break
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return db
}

function seedTaskWithLedger(db: Database.Database): void {
  db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
  db.prepare(
    "INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t1','p1','Task','todo',3)"
  ).run()
  const ins = db.prepare(
    `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
     VALUES (?, ?, 'claude-code', ?, ?, NULL, ?)`
  )
  ins.run('r1', 't1', 'C1', 'slay-spawned-fresh', 1000)
  ins.run('r2', 't1', 'C2', 'slay-spawned-resume', 1001)
}

/** Insert a row whose task does not exist — possible only with enforcement off. */
function seedOrphan(db: Database.Database, id: string, taskId = 'ghost-task'): void {
  db.pragma('foreign_keys = OFF')
  db.prepare(
    `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
     VALUES (?, ?, 'claude-code', 'GHOST', 'slay-spawned-fresh', NULL, 999)`
  ).run(id, taskId)
  db.pragma('foreign_keys = ON')
}

describe('orphan rows do not block the migration chain', () => {
  test('an orphaned task_conversations row does not stop v145 → latest', () => {
    const db = dbAtV145()
    try {
      seedTaskWithLedger(db)
      seedOrphan(db, 'orphan1')
      runMigrations(db)
      expect(db.pragma('user_version', { simple: true })).toEqual(LATEST)
    } finally {
      db.close()
    }
  })

  test('every reachable row still crosses over; the orphan is not carried into agent_sessions', () => {
    const db = dbAtV145()
    try {
      seedTaskWithLedger(db)
      seedOrphan(db, 'orphan1')
      runMigrations(db)
      const ids = (
        db.prepare("SELECT id FROM agent_sessions WHERE task_id = 't1' ORDER BY id").all() as {
          id: string
        }[]
      ).map((r) => r.id)
      expect(ids).toEqual(['r1', 'r2'])
      expect(
        (
          db.prepare("SELECT count(*) AS n FROM agent_sessions WHERE id = 'orphan1'").get() as {
            n: number
          }
        ).n
      ).toBe(0)
    } finally {
      db.close()
    }
  })

  test('the database passes foreign_key_check once migrated', () => {
    const db = dbAtV145()
    try {
      seedTaskWithLedger(db)
      seedOrphan(db, 'orphan1')
      seedOrphan(db, 'orphan2', 'another-ghost')
      runMigrations(db)
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally {
      db.close()
    }
  })

  test('a clean v145 database is unaffected (same sessions, nothing dropped)', () => {
    const db = dbAtV145()
    try {
      seedTaskWithLedger(db)
      runMigrations(db)
      const n = (
        db.prepare("SELECT count(*) AS n FROM agent_sessions WHERE task_id = 't1'").get() as {
          n: number
        }
      ).n
      expect(n).toBe(2)
      expect(db.pragma('user_version', { simple: true })).toEqual(LATEST)
    } finally {
      db.close()
    }
  })
})
