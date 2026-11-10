/**
 * v213: the per-tab session recovery queue (v201) holds terminal sessions only.
 *
 * v201 queued every pre-v201 session of a task that has a non-main tab of the same
 * mode — chat modes included. The recovery (hub session-tab-recovery.ts) can only
 * re-attribute a session from the `pty.create` diagnostics of the spawn that minted it,
 * and only runs when the hub prepares a task before a terminal resume. A chat session
 * has neither, so its row could only ever settle on the main tab — what it already is —
 * yet it stayed queued forever. Found by the migration persona suite
 * (tools/migration-personas, p08-v0380-tabs-usage).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v213-drop-chat-session-tab-recovery-migration.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from './index'

function runRange(db: Database.Database, from: number, to: number): void {
  for (const m of migrations)
    if (m.version > from && m.version <= to)
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
}

const LATEST = () => migrations[migrations.length - 1].version

test('chat-mode rows leave the recovery queue; terminal-mode rows stay', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 212)
    db.exec(`
      INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
      INSERT INTO tasks (id, project_id, title) VALUES ('t', 'p', 'T');
      INSERT INTO session_tab_recovery (task_id, mode, conversation_id, backfilled_at)
        VALUES ('t', 'claude-chat', 'c1', 1), ('t', 'codex-chat', 'c2', 1),
               ('t', 'claude-code', 'c3', 1), ('t', 'codex', 'c4', 1);
    `)
    runRange(db, 212, LATEST())
    expect(
      db
        .prepare('SELECT mode, conversation_id FROM session_tab_recovery ORDER BY conversation_id')
        .all()
    ).toEqual([
      { mode: 'claude-code', conversation_id: 'c3' },
      { mode: 'codex', conversation_id: 'c4' }
    ])
  } finally {
    db.close()
  }
})
